import { type ObjectId, type AnyBulkWriteOperation, type ClientSession } from "mongodb";
import type { TypedDb, RateLimitCounterDoc, RateLimitRule } from "@tokenpanel/db";

export type ViolatedLimit = {
  rule: RateLimitRule;
  current: number;
  cap: number;
  retryAfterSeconds: number;
};

export type CheckLimitsParams = {
  db: TypedDb;
  customerId: ObjectId;
  rules: RateLimitRule[];
  estimatedTokens?: number;
  estimatedSpendMinor?: number;
  modelAliasId?: string;
  scopeTarget?: string;
};

export type RecordUsageParams = {
  db: TypedDb;
  organizationId: ObjectId;
  customerId: ObjectId;
  rules: RateLimitRule[];
  usage: {
    tokens: number;
    requests: number;
    spendMinor: number;
    currency: string;
    modelAliasId?: string;
    scopeTarget?: string;
  };
  occurredAt?: Date;
  /** Optional transaction session — passed to bulkWrite for atomic settlement. */
  session?: ClientSession;
};

export type EnforceParams = {
  db: TypedDb;
  customerId: ObjectId;
  estimatedTokens?: number;
  estimatedSpendMinor?: number;
  modelAliasId?: string;
  scopeTarget?: string;
};

/** Human-readable label for a window length in seconds. */
export function windowSecondsToHuman(s: number): string {
  if (s === 3600) return "1h";
  if (s === 18000) return "5h";
  if (s === 86400) return "1d";
  if (s === 604800) return "1w";
  if (s === 2592000) return "30d";
  return `${s}s`;
}

/** Increment a rule contributes for its dimension. 0 means skip the rule. */
export function ruleIncrement(
  rule: RateLimitRule,
  usage: RecordUsageParams["usage"],
): number {
  switch (rule.dimension) {
    case "tokens":
      return usage.tokens;
    case "requests":
      return 1;
    case "spend_minor":
      return usage.spendMinor;
  }
}

/**
 * Scope target the rule applies to for this call, or null when the rule has
 * no scope target / no filter applies. Returns undefined when the rule
 * should be skipped entirely (e.g. model-scoped rule with no modelAliasId).
 */
export function resolveScopeTarget(
  rule: RateLimitRule,
  modelAliasId: string | undefined,
  scopeTarget: string | undefined,
): string | null | undefined {
  switch (rule.scope) {
    case "customer":
    case "plan":
      return null;
    case "model":
      return modelAliasId ?? rule.scopeTarget ?? undefined;
    case "endpoint":
      return scopeTarget ?? rule.scopeTarget ?? undefined;
  }
}

/**
 * Effective rate-limit rules for a customer: active subscription plan
 * defaults merged with per-customer overrides (override wins by rule id).
 * Only `active: true` rules are returned. Empty if no subscription and no
 * customer limits.
 */
export async function getEffectiveRules(
  db: TypedDb,
  customerId: ObjectId,
): Promise<RateLimitRule[]> {
  const subscription = await db.subscriptions.findOne(
    { customerId, status: "active" },
    { sort: { periodEnd: -1 } },
  );

  const planRules: RateLimitRule[] = [];
  if (subscription) {
    const plan = await db.subscriptionPlans.findOne({ _id: subscription.planId });
    if (plan) {
      for (const r of plan.rateLimits) {
        if (r.active) planRules.push(r);
      }
    }
  }

  const customerLimit = await db.customerLimits.findOne({ customerId });
  const customerRules: RateLimitRule[] = [];
  if (customerLimit) {
    for (const r of customerLimit.rules) {
      if (r.active) customerRules.push(r);
    }
  }

  const byId = new Map<string, RateLimitRule>();
  for (const r of planRules) byId.set(r.id, r);
  for (const r of customerRules) byId.set(r.id, r);

  return [...byId.values()];
}

/**
 * Read-only enforcement check. For each rule, sums current window usage from
 * `rateLimitCounters` and verifies that adding the estimated increment would
 * not exceed the cap. Returns violated rules with retry hints. No writes.
 */
export async function checkLimits(
  params: CheckLimitsParams,
): Promise<{ ok: boolean; violated: ViolatedLimit[] }> {
  const { db, customerId, rules, estimatedTokens, estimatedSpendMinor, modelAliasId, scopeTarget } =
    params;
  const now = Date.now();

  const violated: ViolatedLimit[] = [];

  for (const rule of rules) {
    const target = resolveScopeTarget(rule, modelAliasId, scopeTarget);
    if (target === undefined) continue;

    let increment = 0;
    switch (rule.dimension) {
      case "tokens":
        increment = estimatedTokens ?? 0;
        break;
      case "requests":
        increment = 1;
        break;
      case "spend_minor":
        increment = estimatedSpendMinor ?? 0;
        break;
    }

    const windowStart = new Date(now - rule.windowSeconds * 1000);

    const filter: Record<string, unknown> = {
      customerId,
      dimension: rule.dimension,
      windowSeconds: rule.windowSeconds,
      bucketStart: { $gte: windowStart },
    };
    if (target === null) {
      filter.scopeTarget = null;
    } else {
      filter.scopeTarget = target;
    }

    const docs = await db.rateLimitCounters
      .find(filter, { projection: { count: 1, bucketStart: 1 } })
      .toArray();

    let current = 0;
    let oldestBucketMs = now;
    for (const d of docs) {
      current += d.count;
      const ms = d.bucketStart.getTime();
      if (ms < oldestBucketMs) oldestBucketMs = ms;
    }

    if (current + increment > rule.capValue) {
      const retryAfterSeconds = Math.max(
        1,
        rule.windowSeconds - Math.floor((now - oldestBucketMs) / 1000),
      );
      violated.push({
        rule,
        current,
        cap: rule.capValue,
        retryAfterSeconds,
      });
    }
  }

  return { ok: violated.length === 0, violated };
}

/**
 * Record actual usage into bucketed rolling counters. Called after a
 * successful AI call. Upserts one counter per (rule dimension, window,
 * scopeTarget). Skips rules whose increment is 0 to avoid empty docs.
 */
export async function recordUsage(params: RecordUsageParams): Promise<void> {
  const { db, organizationId, customerId, rules, usage, occurredAt, session } = params;
  const when = occurredAt ?? new Date();
  const nowMs = when.getTime();

  const ops: AnyBulkWriteOperation<RateLimitCounterDoc>[] = [];

  for (const rule of rules) {
    const increment = ruleIncrement(rule, usage);
    if (increment <= 0) continue;

    const target = resolveScopeTarget(rule, usage.modelAliasId, usage.scopeTarget);
    if (target === undefined) continue;

    const bucketStart = new Date(
      Math.floor(nowMs / 1000 / rule.windowSeconds) * rule.windowSeconds * 1000,
    );

    const filter: Record<string, unknown> = {
      organizationId,
      customerId,
      dimension: rule.dimension,
      windowSeconds: rule.windowSeconds,
      bucketStart,
      scopeTarget: target ?? null,
    };

    ops.push({
      updateOne: {
        filter,
        update: {
          $setOnInsert: {
            organizationId,
            customerId,
            dimension: rule.dimension,
            windowSeconds: rule.windowSeconds,
            bucketStart,
            scopeTarget: target ?? null,
          },
          $inc: { count: increment },
        },
        upsert: true,
      },
    });
  }

  if (ops.length > 0) {
    await db.rateLimitCounters.bulkWrite(ops, { session });
  }
}

/**
 * Convenience wrapper for pre-flight enforcement: loads effective rules for
 * the customer then runs the read-only check. Used by proxy middleware
 * before an AI request is forwarded.
 */
export async function enforce(
  params: EnforceParams,
): Promise<{ ok: boolean; violated?: ViolatedLimit[] }> {
  const { db, customerId, estimatedTokens, estimatedSpendMinor, modelAliasId, scopeTarget } =
    params;
  const rules = await getEffectiveRules(db, customerId);
  if (rules.length === 0) return { ok: true };
  const result = await checkLimits({
    db,
    customerId,
    rules,
    estimatedTokens,
    estimatedSpendMinor,
    modelAliasId,
    scopeTarget,
  });
  return result.ok ? { ok: true } : { ok: false, violated: result.violated };
}