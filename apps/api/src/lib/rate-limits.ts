/**
 * Rate-limit evaluation, recording, and enforcement.
 *
 * Persistence is routed through schema-decoding repository ports (task 16.2):
 * no `TypedDb` / raw collection access lives here. Effective-rule resolution
 * reads subscriptions / plans / customer limits via PlansRepo; counter reads
 * and writes go through UsageRepo. Pure rule helpers remain side-effect free.
 *
 * Primary API is Effect (run on ManagedRuntime / AppServices).
 */
import { type ObjectId, type ClientSession } from "mongodb";
import { Effect } from "effect";
import type { RateLimitRule } from "@tokenpanel/db";
import { RATE_LIMIT_PRESET_WINDOWS_SECONDS } from "../domains/limits/policy.ts";
import { UsageRepo } from "../infrastructure/mongo/repositories/usage.ts";
import { PlansRepo } from "../infrastructure/mongo/repositories/plans.ts";
import type { MongoFailure } from "../infrastructure/mongo/try-mongo.ts";
import type { PersistenceDataError } from "../errors/index.ts";

export type ViolatedLimit = {
  rule: RateLimitRule;
  current: number;
  cap: number;
  retryAfterSeconds: number;
};

export type CheckLimitsParams = {
  customerId: ObjectId;
  rules: RateLimitRule[];
  estimatedTokens?: number | undefined;
  estimatedSpendMinor?: number | undefined;
  modelAliasId?: string | undefined;
  scopeTarget?: string | undefined;
  /**
   * Deterministic clock injection (Effect Clock / tests).
   * Defaults to Date.now() when omitted.
   */
  nowMs?: number | undefined;
};

export type RecordUsageParams = {
  organizationId: ObjectId;
  customerId: ObjectId;
  rules: RateLimitRule[];
  usage: {
    tokens: number;
    requests: number;
    spendMinor: number;
    currency: string;
    modelAliasId?: string | undefined;
    scopeTarget?: string | undefined;
  };
  occurredAt?: Date | undefined;
  /** Optional transaction session — passed to the counter bulk upsert. */
  session?: ClientSession | undefined;
};

export type EnforceParams = {
  customerId: ObjectId;
  estimatedTokens?: number | undefined;
  estimatedSpendMinor?: number | undefined;
  modelAliasId?: string | undefined;
  scopeTarget?: string | undefined;
};

export type RateLimitIoError = MongoFailure | PersistenceDataError;

/** Human-readable label for a window length in seconds. */
export function windowSecondsToHuman(s: number): string {
  const p = RATE_LIMIT_PRESET_WINDOWS_SECONDS;
  if (s === p.oneHour) return "1h";
  if (s === p.fiveHours) return "5h";
  if (s === p.oneDay) return "1d";
  if (s === p.oneWeek) return "1w";
  if (s === p.thirtyDays) return "30d";
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
export const getEffectiveRules = (
  customerId: ObjectId,
): Effect.Effect<RateLimitRule[], RateLimitIoError, PlansRepo> =>
  Effect.gen(function* () {
    const plans = yield* PlansRepo;
    const subscription = yield* plans.findActiveSubscriptionByCustomer(customerId);

    const planRules: RateLimitRule[] = [];
    if (subscription) {
      const plan = yield* plans.findPlanByIdNoOrg(subscription.planId);
      if (plan) {
        for (const r of plan.rateLimits) {
          if (r.active) planRules.push(r);
        }
      }
    }

    const customerLimit = yield* plans.findCustomerLimitByCustomer(customerId);
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
  });

/**
 * Read-only enforcement check. For each rule, sums current window usage from
 * `rateLimitCounters` and verifies that adding the estimated increment would
 * not exceed the cap. Returns violated rules with retry hints. No writes.
 */
export const checkLimits = (
  params: CheckLimitsParams,
): Effect.Effect<
  { ok: boolean; violated: ViolatedLimit[] },
  RateLimitIoError,
  UsageRepo
> =>
  Effect.gen(function* () {
    const {
      customerId,
      rules,
      estimatedTokens,
      estimatedSpendMinor,
      modelAliasId,
      scopeTarget,
    } = params;
    const now = params.nowMs ?? Date.now();
    const usageRepo = yield* UsageRepo;
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
      const docs = yield* usageRepo.findWindowCounters({
        customerId,
        dimension: rule.dimension,
        windowSeconds: rule.windowSeconds,
        windowStart,
        scopeTarget: target,
      });

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
  });

/**
 * Record actual usage into bucketed rolling counters. Called after a
 * successful AI call. Upserts one counter per (rule dimension, window,
 * scopeTarget). Skips rules whose increment is 0 to avoid empty docs.
 */
export const recordUsage = (
  params: RecordUsageParams,
): Effect.Effect<void, RateLimitIoError, UsageRepo> =>
  Effect.gen(function* () {
    const { organizationId, customerId, rules, usage, occurredAt } = params;
    const when = occurredAt ?? new Date();
    const nowMs = when.getTime();

    const entries: {
      dimension: string;
      windowSeconds: number;
      bucketStart: Date;
      scopeTarget: string | null;
      increment: number;
    }[] = [];

    for (const rule of rules) {
      const increment = ruleIncrement(rule, usage);
      if (increment <= 0) continue;

      const target = resolveScopeTarget(
        rule,
        usage.modelAliasId,
        usage.scopeTarget,
      );
      if (target === undefined) continue;

      const bucketStart = new Date(
        Math.floor(nowMs / 1000 / rule.windowSeconds) *
          rule.windowSeconds *
          1000,
      );

      entries.push({
        dimension: rule.dimension,
        windowSeconds: rule.windowSeconds,
        bucketStart,
        scopeTarget: target ?? null,
        increment,
      });
    }

    if (entries.length === 0) return;

    const repo = yield* UsageRepo;
    yield* repo.bulkUpsertCounters({
      organizationId,
      customerId,
      ...(params.session !== undefined ? { session: params.session } : {}),
      entries,
    });
  });

/**
 * Convenience: load effective rules then run the read-only check.
 */
export const enforce = (
  params: EnforceParams,
): Effect.Effect<
  { ok: boolean; violated?: ViolatedLimit[] },
  RateLimitIoError,
  PlansRepo | UsageRepo
> =>
  Effect.gen(function* () {
    const {
      customerId,
      estimatedTokens,
      estimatedSpendMinor,
      modelAliasId,
      scopeTarget,
    } = params;
    const rules = yield* getEffectiveRules(customerId);
    if (rules.length === 0) return { ok: true as const };
    const result = yield* checkLimits({
      customerId,
      rules,
      estimatedTokens,
      estimatedSpendMinor,
      modelAliasId,
      scopeTarget,
    });
    return result.ok
      ? { ok: true as const }
      : { ok: false as const, violated: result.violated };
  });
