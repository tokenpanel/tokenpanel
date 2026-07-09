import { ObjectId } from "mongodb";
import {
  getDb,
  getClient,
  type ModelDoc,
  type ModelEntryDoc,
  type ProviderDoc,
  type UsageRecordDoc,
} from "@tokenpanel/db";
import { getAdapter, buildAdapterContext, type ChatRequest, type ChatResponse, type StreamChunk, type ChatMessage } from "../providers/index.ts";
import { decryptSecret } from "./crypto.ts";
import {
  getEffectiveRules,
  checkLimits,
  recordUsage,
  type ViolatedLimit,
} from "./rate-limits.ts";

export class BillingError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export type ResolvedModel = {
  model: ModelDoc;
};

export async function resolveModel(
  orgId: ObjectId,
  aliasId: string,
): Promise<ModelDoc> {
  const db = await getDb();
  const model = await db.models.findOne({
    organizationId: orgId,
    aliasId,
    active: true,
  });
  if (!model) {
    throw new BillingError(404, "model_not_found", `Model '${aliasId}' not found or inactive`);
  }
  return model;
}

export async function checkModelAccess(
  apiKeyModelWhitelist: string[],
  aliasId: string,
): Promise<void> {
  if (apiKeyModelWhitelist.length === 0) return;
  if (!apiKeyModelWhitelist.includes(aliasId)) {
    throw new BillingError(403, "model_not_allowed", `Your API key does not allow model '${aliasId}'`);
  }
}

export async function checkBalance(
  customerId: ObjectId,
  estimatedSpendMinor: number,
  currency: string,
): Promise<void> {
  if (estimatedSpendMinor <= 0) return;
  const db = await getDb();
  const customer = await db.customers.findOne({ _id: customerId });
  if (!customer) {
    throw new BillingError(403, "customer_not_found", "Customer not found");
  }
  if (customer.balance.currency !== currency) {
    // Enforce currency match: previously this returned silently, so a customer
    // whose balance currency differed from the model's could bypass the balance
    // check entirely and go negative (the debit $inc would also mix currencies).
    throw new BillingError(
      402,
      "currency_mismatch",
      "Customer balance currency does not match model currency",
      { balanceCurrency: customer.balance.currency, modelCurrency: currency },
    );
  }
  if (customer.balance.amountMinor < estimatedSpendMinor) {
    throw new BillingError(
      402,
      "insufficient_balance",
      "Insufficient balance to complete request",
      { balanceMinor: customer.balance.amountMinor, requiredMinor: estimatedSpendMinor, currency },
    );
  }
}

type EffectiveRules = Awaited<ReturnType<typeof getEffectiveRules>>;

/**
 * Conservative prompt-token estimate from the translated message array, used by
 * preFlight to enforce balance + token/spend limits BEFORE a paid upstream call.
 * Text content → ~4 chars/token; each non-text part (image/audio) → a fixed
 * overhead. Over-estimating is safe (may reject a marginal request); under-
 * estimating lets a customer exceed limits, which is what this guards against.
 */
const NON_TEXT_PART_TOKENS = 768;

export function estimatePromptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let nonTextParts = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === "text") {
          chars += part.text?.length ?? 0;
        } else {
          nonTextParts += 1;
        }
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4) + nonTextParts * NON_TEXT_PART_TOKENS);
}

/**
 * Fallback completion cap (in tokens) when neither the request nor the model
 * config provides an output limit. OpenAI chat completions may omit
 * max_tokens/max_completion_tokens entirely; without a cap the pre-flight
 * spend estimate for completion tokens would be zero, bypassing balance and
 * spend-limit checks. 4096 is a conservative default that matches the common
 * upstream default; models with a known limits.output use that instead.
 */
export const DEFAULT_COMPLETION_CAP = 4096;

/**
 * Worst-case input + output price (minor units per million tokens) across the
 * model's ACTIVE entries. Settlement charges `entry.price ?? model.price`, so
 * a higher-priced fallback entry can spend more than model.price would suggest.
 * Pre-flight must reserve against the most expensive active entry so balance
 * and spend limits are not bypassed when failover lands on a pricier entry.
 * Entries without a price override fall back to model.price (the floor).
 */
export function worstCaseActiveEntryPrice(model: ModelDoc): {
  inputMinorPerMillion: number;
  outputMinorPerMillion: number;
} {
  const active = model.entries.filter((e) => e.active);
  let maxIn = model.price.inputMinorPerMillion;
  let maxOut = model.price.outputMinorPerMillion;
  for (const e of active) {
    const s = e.price ?? model.price;
    if (s.inputMinorPerMillion > maxIn) maxIn = s.inputMinorPerMillion;
    if (s.outputMinorPerMillion > maxOut) maxOut = s.outputMinorPerMillion;
  }
  return { inputMinorPerMillion: maxIn, outputMinorPerMillion: maxOut };
}

/**
 * Resolve the completion token cap for pre-flight estimation. Preference:
 * request max_tokens > model.limits.output > DEFAULT_COMPLETION_CAP. Returns 0
 * only when explicitly passed 0 (caller intent: no completion expected).
 */
export function resolveCompletionCap(
  maxCompletionTokens: number | undefined,
  model: ModelDoc,
): number {
  if (maxCompletionTokens !== undefined) return Math.max(0, maxCompletionTokens);
  return Math.max(0, model.limits.output ?? DEFAULT_COMPLETION_CAP);
}

export async function preFlight(params: {
  orgId: ObjectId;
  customerId: ObjectId;
  apiKeyModelWhitelist: string[];
  aliasId: string;
  /** Conservative prompt-token estimate (from estimatePromptTokens). */
  estimatedPromptTokens?: number;
  /** Completion cap (max_tokens) — upper bound on output tokens. */
  maxCompletionTokens?: number;
  scopeTarget?: string;
}): Promise<{ model: ModelDoc; rules: EffectiveRules }> {
  await checkModelAccess(params.apiKeyModelWhitelist, params.aliasId);
  const model = await resolveModel(params.orgId, params.aliasId);
  const db = await getDb();
  const rules = await getEffectiveRules(db, params.customerId);

  // Conservative pre-call estimate. Completion is bounded by max_tokens (an
  // upper bound on actual output); prompt by estimatePromptTokens. Spend is
  // derived from the worst-case ACTIVE entry price (entry.price ?? model.price)
  // so higher-priced fallback entries cannot bypass balance/spend limits, and
  // the completion cap falls back to model.limits.output or a default when the
  // request omits max_tokens (OpenAI allows this) — previously completion was
  // estimated as zero, so balance + spend/token limits were never enforced and
  // customers could go negative / exceed limits until settlement.
  const prompt = Math.max(0, params.estimatedPromptTokens ?? 0);
  const completion = resolveCompletionCap(params.maxCompletionTokens, model);
  const estimatedTokens = prompt + completion;
  const price = worstCaseActiveEntryPrice(model);
  const estimatedSpendMinor =
    Math.ceil((prompt * price.inputMinorPerMillion) / 1_000_000) +
    Math.ceil((completion * price.outputMinorPerMillion) / 1_000_000);

  if (rules.length > 0 && estimatedTokens > 0) {
    const result = await checkLimits({
      db,
      customerId: params.customerId,
      rules,
      estimatedTokens,
      estimatedSpendMinor,
      modelAliasId: params.aliasId,
      scopeTarget: params.scopeTarget,
    });
    if (!result.ok) {
      const v = result.violated[0] as ViolatedLimit | undefined;
      if (v) {
        throw new BillingError(429, "rate_limited", `Rate limit exceeded: ${v.rule.dimension} cap ${v.cap} in ${v.rule.windowSeconds}s window`, {
          retryAfterSeconds: v.retryAfterSeconds,
          dimension: v.rule.dimension,
          cap: v.cap,
          current: v.current,
          windowSeconds: v.rule.windowSeconds,
        });
      }
      throw new BillingError(429, "rate_limited", "Rate limit exceeded");
    }
  }
  if (estimatedSpendMinor > 0) {
    await checkBalance(params.customerId, estimatedSpendMinor, model.currency);
  }
  return { model, rules };
}

async function loadProvider(orgId: ObjectId, providerId: ObjectId): Promise<ProviderDoc> {
  const db = await getDb();
  const provider = await db.providers.findOne({
    _id: providerId,
    organizationId: orgId,
    active: true,
  });
  if (!provider) {
    throw new BillingError(502, "provider_unavailable", "Configured provider is inactive or missing");
  }
  return provider;
}

export type CallOutcome = {
  entry: ModelEntryDoc;
  provider: ProviderDoc;
  response: ChatResponse;
};

export async function callWithFallback(params: {
  orgId: ObjectId;
  model: ModelDoc;
  request: ChatRequest;
}): Promise<CallOutcome> {
  const { orgId, model, request } = params;
  const entries = [...model.entries]
    .filter((e) => e.active)
    .sort((a, b) => a.priority - b.priority);

  if (entries.length === 0) {
    throw new BillingError(503, "no_active_entries", "Model has no active provider entries");
  }

  let lastError: Error | null = null;
  for (const entry of entries) {
    try {
      const provider = await loadProvider(orgId, entry.providerId);
      const adapter = getAdapter(provider.sdkType);
      if (!adapter) {
        throw new BillingError(502, "adapter_missing", `No adapter for sdkType '${provider.sdkType}'`);
      }
      const apiKey = decryptSecret(provider.apiKeyEncrypted);
      const ctx = buildAdapterContext({
        baseUrl: provider.baseUrl,
        apiKey,
        providerOrg: provider.providerOrg,
        headers: provider.headers,
      });
      const upstreamReq: ChatRequest = {
        ...request,
        model: entry.upstreamModelId,
      };
      const response = await adapter.chatComplete(ctx, upstreamReq);
      return { entry, provider, response };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof BillingError && err.status !== 502) {
        throw err;
      }
      continue;
    }
  }
  throw new BillingError(502, "all_providers_failed", lastError?.message ?? "All providers failed");
}

export async function* streamWithFallback(params: {
  orgId: ObjectId;
  model: ModelDoc;
  request: ChatRequest;
}): AsyncGenerator<{ entry: ModelEntryDoc; provider: ProviderDoc; chunk: StreamChunk }, void, void> {
  const { orgId, model, request } = params;
  const entries = [...model.entries]
    .filter((e) => e.active)
    .sort((a, b) => a.priority - b.priority);

  if (entries.length === 0) {
    throw new BillingError(503, "no_active_entries", "Model has no active provider entries");
  }

  for (const entry of entries) {
    try {
      const provider = await loadProvider(orgId, entry.providerId);
      const adapter = getAdapter(provider.sdkType);
      if (!adapter) {
        throw new BillingError(502, "adapter_missing", `No adapter for sdkType '${provider.sdkType}'`);
      }
      const apiKey = decryptSecret(provider.apiKeyEncrypted);
      const ctx = buildAdapterContext({
        baseUrl: provider.baseUrl,
        apiKey,
        providerOrg: provider.providerOrg,
        headers: provider.headers,
      });
      const upstreamReq: ChatRequest = {
        ...request,
        model: entry.upstreamModelId,
      };
      for await (const chunk of adapter.streamChat(ctx, upstreamReq)) {
        yield { entry, provider, chunk };
      }
      return;
    } catch (err) {
      if (err instanceof BillingError && err.status !== 502) {
        throw err;
      }
      continue;
    }
  }
  throw new BillingError(502, "all_providers_failed", "All providers failed for stream");
}

/**
 * Compute cost (what org pays) and price (what we charge customer) in minor
 * units from token counts + the model's price schedule. Cost uses the entry's
 * cost override if present, else 0 (cost tracking optional without catalog).
 * Price uses entry price override, else model.price.
 */
export function computeCharges(params: {
  entry: ModelEntryDoc;
  model: ModelDoc;
  usage: ChatResponse["usage"];
}): { costMinor: number; priceMinor: number; currency: string } {
  const { entry, model, usage } = params;
  const priceSchedule = entry.price ?? model.price;
  const costSchedule = entry.cost;

  const priceMinor =
    Math.ceil((usage.promptTokens * (priceSchedule.inputMinorPerMillion ?? 0)) / 1_000_000) +
    Math.ceil((usage.completionTokens * (priceSchedule.outputMinorPerMillion ?? 0)) / 1_000_000) +
    Math.ceil(((usage.reasoningTokens ?? 0) * (priceSchedule.reasoningMinorPerMillion ?? 0)) / 1_000_000) +
    Math.ceil(((usage.cacheReadTokens ?? 0) * (priceSchedule.cacheReadMinorPerMillion ?? 0)) / 1_000_000) +
    Math.ceil(((usage.cacheWriteTokens ?? 0) * (priceSchedule.cacheWriteMinorPerMillion ?? 0)) / 1_000_000);

  const costMinor = costSchedule
    ? Math.ceil((usage.promptTokens * (costSchedule.inputMinorPerMillion ?? 0)) / 1_000_000) +
      Math.ceil((usage.completionTokens * (costSchedule.outputMinorPerMillion ?? 0)) / 1_000_000) +
      Math.ceil(((usage.reasoningTokens ?? 0) * (costSchedule.reasoningMinorPerMillion ?? 0)) / 1_000_000) +
      Math.ceil(((usage.cacheReadTokens ?? 0) * (costSchedule.cacheReadMinorPerMillion ?? 0)) / 1_000_000) +
      Math.ceil(((usage.cacheWriteTokens ?? 0) * (costSchedule.cacheWriteMinorPerMillion ?? 0)) / 1_000_000)
    : 0;

  return { costMinor, priceMinor, currency: model.currency };
}

/**
 * Settlement guard failure: the customer no longer matches the expected
 * org/currency/state, so the debit must NOT happen. Thrown inside the
 * transaction to abort it atomically; caught by settleUsage and logged.
 */
class SettlementGuardError extends Error {}

/**
 * Who is being settled for. `customerId` decides whether the customer balance
 * is debited and counters are written:
 *  - customerId set → billed path: insert usage record, debit balance, write
 *    ledger + rate-limit counters (the standard customer-key path, plus the
 *    management-attributed-to-customer path).
 *  - customerId null → internal path: insert usage record for audit/analytics
 *    only. No debit, no counters. Used for org-internal management calls and
 *    playground-without-customer.
 *
 * `actorKind` is recorded verbatim on the usage record so analytics can split
 * customer vs management vs playground traffic.
 */
export type SettlementActor = {
  actorKind: "customer_key" | "management_key" | "playground";
  /** Customer to bill. null for org-internal calls. */
  customerId: ObjectId | null;
  /** Customer API key (`tp_live_`) when actorKind is customer_key. */
  apiKeyId?: ObjectId | null;
  /** Management API key (`tp_mgmt_`) when actorKind is management_key. */
  managementKeyId?: ObjectId | null;
  /** Snapshot of the customerEmail used for management attribution, if any. */
  customerEmail?: string | null;
};

export async function settleUsage(params: {
  orgId: ObjectId;
  actor: SettlementActor;
  model: ModelDoc;
  entry: ModelEntryDoc;
  provider: ProviderDoc;
  protocol: "openai" | "anthropic";
  usage: ChatResponse["usage"];
  costMinor: number;
  priceMinor: number;
  currency: string;
  providerRequestId?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  rules: EffectiveRules;
}): Promise<void> {
  const db = await getDb();
  const client = getClient();
  const now = new Date();
  const occurredAt = now;
  const actor = params.actor;

  // Resolve billing intent from the actor. Internal calls (customerId null)
  // skip the debit + ledger + counter writes entirely.
  const customerId = actor.customerId;
  const billed = customerId !== null;

  const usageRecord: Omit<UsageRecordDoc, "_id" | "createdAt" | "updatedAt"> = {
    organizationId: params.orgId,
    customerId,
    apiKeyId: actor.apiKeyId ?? null,
    actorKind: actor.actorKind,
    managementKeyId: actor.managementKeyId ?? null,
    customerEmail: actor.customerEmail ?? null,
    modelAliasId: params.model.aliasId,
    providerId: params.provider._id,
    upstreamModelId: params.entry.upstreamModelId,
    protocol: params.protocol,
    promptTokens: params.usage.promptTokens,
    completionTokens: params.usage.completionTokens,
    reasoningTokens: params.usage.reasoningTokens ?? 0,
    cacheReadTokens: params.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: params.usage.cacheWriteTokens ?? 0,
    totalTokens: params.usage.totalTokens,
    costMinor: params.costMinor,
    priceMinor: params.priceMinor,
    currency: params.currency,
    providerRequestId: params.providerRequestId,
    billed,
    errorCode: params.errorCode,
    status: params.status,
    durationMs: params.durationMs,
    occurredAt,
  };

  // Wrap usage insert + (optional) balance debit + (optional) ledger entry +
  // (optional) rate counters in ONE transaction so a failure can never leave a
  // partial charge. For internal calls, only the usage record is inserted
  // (no debit, no counters) — analytics-only attribution. The balance update
  // carries org/currency/not-closed guards: if the customer was closed, moved
  // orgs, or changed currency mid-flight, the debit is refused and the whole
  // txn aborts atomically.
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await db.usageRecords.insertOne(
        {
          _id: new ObjectId(),
          ...usageRecord,
          createdAt: now,
          updatedAt: now,
        } as UsageRecordDoc,
        { session },
      );

      if (billed && customerId !== null && params.priceMinor > 0) {
        const debit = await db.customers.updateOne(
          {
            _id: customerId,
            organizationId: params.orgId,
            "balance.currency": params.currency,
            status: { $ne: "closed" },
          },
          {
            $inc: { "balance.amountMinor": -params.priceMinor },
            $set: { updatedAt: now },
          },
          { session },
        );
        if (debit.matchedCount === 0) {
          // Guard failed: refuse the debit and abort the transaction atomically.
          throw new SettlementGuardError();
        }
        await db.balanceAdjustments.insertOne(
          {
            _id: new ObjectId(),
            organizationId: params.orgId,
            customerId,
            amountMinor: -params.priceMinor,
            currency: params.currency,
            reason: "usage_debit",
            occurredAt,
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
      }

      if (billed && customerId !== null) {
        await recordUsage({
          db,
          organizationId: params.orgId,
          customerId,
          rules: params.rules,
          usage: {
            tokens: params.usage.totalTokens,
            requests: 1,
            spendMinor: params.priceMinor,
            currency: params.currency,
            modelAliasId: params.model.aliasId,
          },
          occurredAt,
          session,
        });
      }
    });
  } catch (err) {
    if (err instanceof SettlementGuardError) {
      console.error("[settleUsage] balance guard failed — no charge applied", {
        customerId: customerId?.toHexString() ?? null,
        orgId: params.orgId.toHexString(),
        currency: params.currency,
        priceMinor: params.priceMinor,
      });
      // The transaction above aborted, so the usage insert was rolled back.
      // But the upstream call already succeeded and the caller already got a
      // 200. Losing the audit record would make this free service invisible
      // to analytics/operators and break attribution. Re-insert an audit-only
      // copy of the usage record with billed:false so the event is visible
      // (and distinguishable from a successful charge). Best-effort: a failure
      // here is logged but never re-thrown — the caller already has its
      // response and the guard condition is a downstream-state issue, not a
      // caller error.
      try {
        await db.usageRecords.insertOne({
          _id: new ObjectId(),
          ...{ ...usageRecord, billed: false },
          createdAt: now,
          updatedAt: now,
        } as UsageRecordDoc);
      } catch (insertErr) {
        console.error("[settleUsage] audit re-insert after guard failure also failed", {
          customerId: customerId?.toHexString() ?? null,
          orgId: params.orgId.toHexString(),
          error: String(insertErr),
        });
      }
      return;
    }
    throw err;
  } finally {
    await session.endSession();
  }
}