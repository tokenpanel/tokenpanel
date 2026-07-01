import { ObjectId } from "mongodb";
import {
  getDb,
  type ModelDoc,
  type ModelEntryDoc,
  type ProviderDoc,
  type UsageRecordDoc,
} from "@tokenpanel/db";
import { getAdapter, buildAdapterContext, type ChatRequest, type ChatResponse, type StreamChunk } from "../providers/index.ts";
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
    return;
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

export async function preFlight(params: {
  orgId: ObjectId;
  customerId: ObjectId;
  apiKeyModelWhitelist: string[];
  aliasId: string;
  estimatedTokens?: number;
  estimatedSpendMinor?: number;
  scopeTarget?: string;
}): Promise<{ model: ModelDoc; rules: EffectiveRules }> {
  await checkModelAccess(params.apiKeyModelWhitelist, params.aliasId);
  const model = await resolveModel(params.orgId, params.aliasId);
  const db = await getDb();
  const rules = await getEffectiveRules(db, params.customerId);
  if (rules.length > 0) {
    const result = await checkLimits({
      db,
      customerId: params.customerId,
      rules,
      estimatedTokens: params.estimatedTokens,
      estimatedSpendMinor: params.estimatedSpendMinor,
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
  if (params.estimatedSpendMinor && params.estimatedSpendMinor > 0) {
    await checkBalance(params.customerId, params.estimatedSpendMinor, model.currency);
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

export async function settleUsage(params: {
  orgId: ObjectId;
  customerId: ObjectId;
  apiKeyId: ObjectId | null;
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
  const now = new Date();
  const occurredAt = now;

  const usageRecord: Omit<UsageRecordDoc, "_id" | "createdAt" | "updatedAt"> = {
    organizationId: params.orgId,
    customerId: params.customerId,
    apiKeyId: params.apiKeyId,
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
    billed: true,
    errorCode: params.errorCode,
    status: params.status,
    durationMs: params.durationMs,
    occurredAt,
  };

  await db.usageRecords.insertOne({
    _id: new ObjectId(),
    ...usageRecord,
    createdAt: now,
    updatedAt: now,
  } as UsageRecordDoc);

  if (params.priceMinor > 0) {
    await db.customers.updateOne(
      { _id: params.customerId },
      { $inc: { "balance.amountMinor": -params.priceMinor }, $set: { updatedAt: now } },
    );
    await db.balanceAdjustments.insertOne({
      _id: new ObjectId(),
      organizationId: params.orgId,
      customerId: params.customerId,
      amountMinor: -params.priceMinor,
      currency: params.currency,
      reason: "usage_debit",
      occurredAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  await recordUsage({
    db,
    organizationId: params.orgId,
    customerId: params.customerId,
    rules: params.rules,
    usage: {
      tokens: params.usage.totalTokens,
      requests: 1,
      spendMinor: params.priceMinor,
      currency: params.currency,
      modelAliasId: params.model.aliasId,
    },
    occurredAt,
  });
}