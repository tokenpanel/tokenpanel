/**
 * Reconciliation worker: drains settlement_outbox pending/expired-lease rows.
 * Retries settleUsage when context holds a full usage + pricing snapshot.
 * Missing-usage rows without recoverable usage abandon immediately (no
 * provider usage-lookup API yet — spinning 20 times wastes work).
 */

import { ObjectId } from "mongodb";
import {
  getDb,
  type ModelDoc,
  type ModelEntryDoc,
  type ProviderDoc,
  type SettlementOutboxDoc,
} from "@tokenpanel/db";
import {
  claimDueOutboxRows,
  claimFromRow,
  compactGatewayRequestId,
  markOutboxReconciled,
  markOutboxAbandoned,
  releaseOutboxAfterFailure,
  renewOutboxClaim,
  type OutboxClaim,
} from "./settlement-outbox.ts";
import {
  applyTokenSchedule,
  cacheAccountingForProtocol,
  settleUsage,
  type ChargeSchedule,
  type SettlementActor,
} from "../lib/billing.ts";
import { getEffectiveRules } from "../lib/rate-limits.ts";
import type {
  CacheAccountingMode,
  TokenUsage,
} from "../providers/provider-usage.ts";

function isTokenUsage(v: unknown): v is TokenUsage {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.promptTokens === "number" &&
    Number.isSafeInteger(o.promptTokens) &&
    typeof o.completionTokens === "number" &&
    Number.isSafeInteger(o.completionTokens) &&
    typeof o.totalTokens === "number" &&
    Number.isSafeInteger(o.totalTokens) &&
    o.promptTokens >= 0 &&
    o.completionTokens >= 0 &&
    o.totalTokens >= 0
  );
}

function actorFromContext(
  row: SettlementOutboxDoc,
  ctx: Record<string, unknown>,
): SettlementActor {
  const kind = ctx.actorKind;
  const actorKind =
    kind === "management_key" || kind === "playground" || kind === "customer_key"
      ? kind
      : "customer_key";
  return {
    actorKind,
    customerId: row.customerId ?? null,
    apiKeyId:
      typeof ctx.apiKeyId === "string" && ObjectId.isValid(ctx.apiKeyId)
        ? new ObjectId(ctx.apiKeyId)
        : null,
    managementKeyId:
      typeof ctx.managementKeyId === "string" &&
      ObjectId.isValid(ctx.managementKeyId)
        ? new ObjectId(ctx.managementKeyId)
        : null,
    customerEmail:
      typeof ctx.customerEmail === "string" ? ctx.customerEmail : null,
  };
}

/**
 * Resolve the original model entry only — never fall back to an unrelated
 * active/first entry (that would settle against the wrong upstream model /
 * pricing). When the live entry is gone but the outbox frozen a price +
 * upstream id, reconstruct a stub for attribution metadata only.
 */
function resolveEntry(params: {
  modelEntries: ModelEntryDoc[];
  providerId: ObjectId;
  upstreamModelId: string | undefined;
  ctx: Record<string, unknown>;
}):
  | { ok: true; entry: ModelEntryDoc }
  | { ok: false; reason: string } {
  const { modelEntries, providerId, upstreamModelId, ctx } = params;
  if (upstreamModelId) {
    const exact = modelEntries.find(
      (e) =>
        e.providerId.equals(providerId) && e.upstreamModelId === upstreamModelId,
    );
    if (exact) return { ok: true, entry: exact };
  } else {
    // No upstream id stored: only accept a single matching-provider entry.
    const matches = modelEntries.filter((e) => e.providerId.equals(providerId));
    if (matches.length === 1 && matches[0]) {
      return { ok: true, entry: matches[0] };
    }
    if (matches.length > 1) {
      return { ok: false, reason: "entry_ambiguous_no_upstream_id" };
    }
  }

  // Original entry gone. Only continue if context froze price + upstream id.
  const frozenPrice =
    typeof ctx.priceMinor === "number" && Number.isFinite(ctx.priceMinor);
  const frozenUpstream =
    upstreamModelId ??
    (typeof ctx.upstreamModelId === "string" ? ctx.upstreamModelId : undefined);
  if (frozenPrice && frozenUpstream) {
    const stub: ModelEntryDoc = {
      id: "recon-stub",
      providerId,
      upstreamModelId: frozenUpstream,
      priority: 0,
      active: false,
    };
    return { ok: true, entry: stub };
  }
  return { ok: false, reason: "entry_not_found" };
}

/**
 * Reconstruct minimal model/provider docs from frozen outbox context when live
 * config was deleted. settleUsage only needs aliasId / provider._id / entry
 * upstream attribution + precomputed price — not live secrets or base URLs.
 */
function reconstructFrozenAttribution(params: {
  row: SettlementOutboxDoc;
  ctx: Record<string, unknown>;
  providerId: ObjectId;
  upstreamModelId: string;
  currency: string;
  priceSchedule: ChargeSchedule;
}): { model: ModelDoc; provider: ProviderDoc; entry: ModelEntryDoc } {
  const { row, ctx, providerId, upstreamModelId, currency, priceSchedule } =
    params;
  const now = row.createdAt;
  // tokenPriceSchedule requires input/output numbers.
  const price = {
    inputMinorPerMillion: priceSchedule.inputMinorPerMillion ?? 0,
    outputMinorPerMillion: priceSchedule.outputMinorPerMillion ?? 0,
    ...(priceSchedule.reasoningMinorPerMillion !== undefined
      ? { reasoningMinorPerMillion: priceSchedule.reasoningMinorPerMillion }
      : {}),
    ...(priceSchedule.cacheReadMinorPerMillion !== undefined
      ? { cacheReadMinorPerMillion: priceSchedule.cacheReadMinorPerMillion }
      : {}),
    ...(priceSchedule.cacheWriteMinorPerMillion !== undefined
      ? { cacheWriteMinorPerMillion: priceSchedule.cacheWriteMinorPerMillion }
      : {}),
  };
  const entry: ModelEntryDoc = {
    id: "recon-stub",
    providerId,
    upstreamModelId,
    priority: 0,
    active: false,
    price,
  };
  const model: ModelDoc = {
    _id: new ObjectId(),
    organizationId: row.organizationId,
    aliasId: row.modelAliasId,
    displayName: row.modelAliasId,
    description: null,
    entries: [entry],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 0 },
    modalities: { input: ["text"], output: ["text"] },
    price,
    marginBps: 0,
    currency,
    active: false,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
  const provider: ProviderDoc = {
    _id: providerId,
    organizationId: row.organizationId,
    name: "recon-stub",
    sdkType: "openai-compatible",
    apiKeyEncrypted: "recon-stub",
    baseUrl: "https://invalid.invalid",
    providerOrg: null,
    headers: {},
    active: false,
    metadata: {
      reconstructed: true,
      ...(typeof ctx.providerId === "string" ? { frozenProviderId: ctx.providerId } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
  return { model, provider, entry };
}

/**
 * Attempt to settle one outbox row.
 * settleUsage is idempotent on gatewayRequestId — safe if prior attempt
 * committed the charge but crashed before markOutboxReconciled.
 */
export async function reconcileOutboxRow(
  row: SettlementOutboxDoc,
  claim: OutboxClaim,
): Promise<"reconciled" | "retry" | "abandoned" | "stale_claim"> {
  const ctx = (row.context ?? {}) as Record<string, unknown>;
  const usage = ctx.usage;
  const hasUsage = isTokenUsage(usage);

  // No provider usage-lookup path yet: spinning unchanged snapshots is useless.
  // Abandon immediately so ops can re-enqueue after manual/provider recovery.
  if (!hasUsage) {
    const ok = await markOutboxAbandoned(
      row._id,
      claim,
      row.reason || "missing_usage_no_provider_lookup",
    );
    return ok ? "abandoned" : "stale_claim";
  }

  const db = await getDb();

  // Idempotency first — crash-after-commit rows must mark reconciled even when
  // live model/provider were deleted. Do not require live config for this path.
  if (row.gatewayRequestId) {
    const gwId = compactGatewayRequestId(row.gatewayRequestId);
    const existing = await db.usageRecords.findOne({ gatewayRequestId: gwId });
    if (existing) {
      const ok = await markOutboxReconciled(row._id, claim);
      return ok ? "reconciled" : "stale_claim";
    }
  }

  // Renew lease before potentially slow DB work.
  if (!(await renewOutboxClaim(row._id, claim))) {
    return "stale_claim";
  }

  const providerId =
    row.providerId ??
    (typeof ctx.providerId === "string" && ObjectId.isValid(ctx.providerId)
      ? new ObjectId(ctx.providerId)
      : undefined);
  if (!providerId) {
    const ok = await releaseOutboxAfterFailure(
      row._id,
      claim,
      "provider_id_missing",
    );
    return ok ? "retry" : "stale_claim";
  }

  const upstreamModelId =
    row.upstreamModelId ??
    (typeof ctx.upstreamModelId === "string" ? ctx.upstreamModelId : undefined);

  const priceMinor =
    typeof ctx.priceMinor === "number" && Number.isFinite(ctx.priceMinor)
      ? Math.floor(ctx.priceMinor)
      : undefined;
  const costMinorFrozen =
    typeof ctx.costMinor === "number" && Number.isFinite(ctx.costMinor)
      ? Math.floor(ctx.costMinor)
      : undefined;
  const frozenSchedule = ctx.priceSchedule as ChargeSchedule | undefined;

  let model = await db.models.findOne({
    organizationId: row.organizationId,
    aliasId: row.modelAliasId,
  });
  let provider = await db.providers.findOne({
    _id: providerId,
    organizationId: row.organizationId,
  });

  let entry: ModelEntryDoc | undefined;
  if (model) {
    const entryResult = resolveEntry({
      modelEntries: model.entries,
      providerId,
      upstreamModelId,
      ctx,
    });
    if (entryResult.ok) entry = entryResult.entry;
  }

  // Deleted live config: reconstruct from frozen price + upstream attribution.
  // Prefer frozen priceMinor or priceSchedule so we can still settle.
  const canReconstruct =
    (priceMinor !== undefined || frozenSchedule !== undefined) &&
    !!upstreamModelId;

  if ((!model || !provider || !entry) && canReconstruct && upstreamModelId) {
    const currency =
      typeof ctx.currency === "string" && ctx.currency.length > 0
        ? ctx.currency
        : model?.currency ?? "USD";
    const priceSchedule: ChargeSchedule =
      frozenSchedule ??
      entry?.price ??
      model?.price ??
      { inputMinorPerMillion: 0, outputMinorPerMillion: 0 };
    const stubs = reconstructFrozenAttribution({
      row,
      ctx,
      providerId,
      upstreamModelId,
      currency,
      priceSchedule,
    });
    if (!model) model = stubs.model;
    if (!provider) provider = stubs.provider;
    if (!entry) entry = stubs.entry;
  }

  if (!model) {
    const ok = await releaseOutboxAfterFailure(
      row._id,
      claim,
      "model_not_found",
    );
    return ok ? "retry" : "stale_claim";
  }
  if (!provider) {
    const ok = await releaseOutboxAfterFailure(
      row._id,
      claim,
      "provider_not_found",
    );
    return ok ? "retry" : "stale_claim";
  }
  if (!entry) {
    const ok = await releaseOutboxAfterFailure(
      row._id,
      claim,
      "entry_not_found",
    );
    return ok ? "retry" : "stale_claim";
  }

  const currency =
    typeof ctx.currency === "string" && ctx.currency.length > 0
      ? ctx.currency
      : model.currency;

  const protocol =
    row.protocol === "anthropic" || row.protocol === "openai"
      ? row.protocol
      : "openai";

  // Prefer frozen mode from outbox context / usage stamp — never amount heuristics.
  const frozenMode: CacheAccountingMode | undefined =
    ctx.cacheAccounting === "subset" || ctx.cacheAccounting === "additive"
      ? ctx.cacheAccounting
      : usage.cacheAccounting === "subset" || usage.cacheAccounting === "additive"
        ? usage.cacheAccounting
        : cacheAccountingForProtocol(protocol);
  const usageWithMode: TokenUsage = {
    ...usage,
    cacheAccounting: frozenMode,
  };

  let finalPrice = priceMinor;
  let finalCost = costMinorFrozen ?? 0;
  if (finalPrice === undefined) {
    // Prefer frozen schedule from context over live entry (entry may be stub
    // or repriced since the original request). Same tier math as computeCharges.
    const priceSchedule =
      frozenSchedule ?? entry.price ?? model.price;
    finalPrice = applyTokenSchedule(priceSchedule, usageWithMode, {
      cacheAccounting: frozenMode,
    });
    if (ctx.priceMinorOverride === 0) finalPrice = 0;
  }
  if (costMinorFrozen === undefined && ctx.costSchedule && typeof ctx.costSchedule === "object") {
    finalCost = applyTokenSchedule(ctx.costSchedule as ChargeSchedule, usageWithMode, {
      cacheAccounting: frozenMode,
    });
  }

  const actor = actorFromContext(row, ctx);
  // Prefer rules snapshot frozen at enqueue when present; else current rules.
  const rules =
    Array.isArray(ctx.rules)
      ? (ctx.rules as Awaited<ReturnType<typeof getEffectiveRules>>)
      : actor.customerId !== null
        ? await getEffectiveRules(db, actor.customerId)
        : [];

  // Prefer request-time timestamp frozen at enqueue; fall back to outbox
  // createdAt (approx request time) — never recon wall clock alone.
  let occurredAt: Date;
  if (typeof ctx.occurredAt === "string" || ctx.occurredAt instanceof Date) {
    const parsed = new Date(ctx.occurredAt as string | Date);
    occurredAt = Number.isNaN(parsed.getTime()) ? row.createdAt : parsed;
  } else {
    occurredAt = row.createdAt;
  }

  try {
    // Idempotent on gatewayRequestId: crash between settle and mark is safe.
    const reservedMinor =
      typeof ctx.reservedMinor === "number" &&
      Number.isSafeInteger(ctx.reservedMinor) &&
      ctx.reservedMinor > 0
        ? ctx.reservedMinor
        : 0;
    await settleUsage({
      orgId: row.organizationId,
      actor,
      model,
      entry,
      provider,
      protocol,
      usage: usageWithMode,
      costMinor: finalCost,
      priceMinor: finalPrice,
      currency,
      providerRequestId: row.providerRequestId,
      gatewayRequestId: row.gatewayRequestId,
      status: typeof ctx.status === "number" ? ctx.status : 200,
      durationMs: typeof ctx.durationMs === "number" ? ctx.durationMs : 0,
      errorCode:
        typeof ctx.errorCode === "string" ? ctx.errorCode : undefined,
      rules,
      occurredAt,
      reservedMinor,
      rethrowGuardFailure: true,
      skipGuardAudit: true,
    });
    const ok = await markOutboxReconciled(row._id, claim);
    return ok ? "reconciled" : "stale_claim";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ok = await releaseOutboxAfterFailure(row._id, claim, msg);
    return ok ? "retry" : "stale_claim";
  }
}

export async function processSettlementOutboxBatch(
  limit = 20,
): Promise<{ claimed: number; reconciled: number; abandoned: number }> {
  const claimed = await claimDueOutboxRows(limit);
  let reconciled = 0;
  let abandoned = 0;
  for (const row of claimed) {
    const claim = claimFromRow(row);
    if (!claim) {
      console.error("[settlement-reconcile] claimed row missing claimToken", {
        id: row._id.toHexString(),
      });
      continue;
    }
    try {
      const result = await reconcileOutboxRow(row, claim);
      if (result === "reconciled") reconciled += 1;
      if (result === "abandoned") abandoned += 1;
    } catch (err) {
      console.error("[settlement-reconcile] row failed", {
        id: row._id.toHexString(),
        error: err instanceof Error ? err.message : String(err),
      });
      await releaseOutboxAfterFailure(
        row._id,
        claim,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { claimed: claimed.length, reconciled, abandoned };
}

let reconTimer: ReturnType<typeof setInterval> | null = null;

export function startSettlementReconcileWorker(opts?: {
  intervalMs?: number;
  batchSize?: number;
}): void {
  if (reconTimer) return;
  const intervalMs = opts?.intervalMs ?? 15_000;
  const batchSize = opts?.batchSize ?? 20;
  const tick = () => {
    void processSettlementOutboxBatch(batchSize)
      .then((r) => {
        if (r.claimed > 0) {
          console.log(
            `[settlement-reconcile] claimed=${r.claimed} reconciled=${r.reconciled} abandoned=${r.abandoned}`,
          );
        }
      })
      .catch((err) => {
        console.error(
          "[settlement-reconcile] batch error",
          err instanceof Error ? err.message : err,
        );
      });
  };
  setTimeout(tick, 3_000);
  reconTimer = setInterval(tick, intervalMs);
  if (typeof reconTimer === "object" && reconTimer && "unref" in reconTimer) {
    reconTimer.unref();
  }
}

export function stopSettlementReconcileWorker(): void {
  if (reconTimer) {
    clearInterval(reconTimer);
    reconTimer = null;
  }
}
