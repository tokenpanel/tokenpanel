/**
 * Rate-limit evaluation, reservation, settlement, and enforcement.
 *
 * Persistence is routed through schema-decoding repository ports (task 16.2):
 * no `TypedDb` / raw collection access lives here. Effective-rule resolution
 * reads subscriptions / plans / customer limits via PlansRepo; counter reads
 * and writes go through UsageRepo. Pure rule helpers remain side-effect free.
 *
 * Admission control uses atomic reservations (same shape as balance holds):
 *  1. preflight → reserveLimits (check window sum + $inc estimate in one txn)
 *  2. success   → settleLimits (adjust by actual − reserved on held buckets)
 *  3. failure   → releaseLimits (reverse holds)
 *
 * Estimates at admission (actual tokens/spend unknown until provider completes):
 * conservative prompt + completion cap / spend estimate; requests always 1.
 *
 * Cap semantics by dimension:
 *  - tokens / requests — **hard**. Window sum must never exceed cap. Admission
 *    reserves against the cap; settle clamps any underestimate overshoot so
 *    counters stay ≤ cap (usage records still store true provider tokens).
 *  - spend_units — **soft**. Like balance overdraft, spend counters may exceed
 *    cap when actual spend > reserved estimate. Still reserved at admission so
 *    concurrent requests cannot all claim the same remaining budget.
 *    Caps are org-currency units (single currency per org).
 *
 * Windows are rolling: usage is stored in sub-buckets smaller than the window
 * and summed over [now − window, now]. Product policy: at most one active rule
 * per counter stream (dimension + window + scope target) — enforced on plan
 * write via @tokenpanel/contracts. Effective-rule resolution also collapses
 * legacy duplicates to the strictest cap. Writes for the same stream key are
 * still coalesced (defensive).
 *
 * Counter values are never stored negative (release floors at 0).
 *
 * Primary API is Effect (run on ManagedRuntime / AppServices).
 */
import { type ObjectId, type ClientSession } from "mongodb";
import { Effect } from "effect";
import type { RateLimitRule } from "@tokenpanel/db";
import { rateLimitStreamKey } from "@tokenpanel/contracts";
import { RATE_LIMIT_PRESET_WINDOWS_SECONDS } from "../domains/limits/policy.ts";
import { UsageRepo } from "../infrastructure/mongo/repositories/usage.ts";
import { PlansRepo } from "../infrastructure/mongo/repositories/plans.ts";
import { withMongoSession } from "../infrastructure/mongo/session.ts";
import type { MongoDb } from "../runtime/services/mongo-db.ts";
import type { MongoFailure } from "../infrastructure/mongo/try-mongo.ts";
import type { PersistenceDataError } from "../errors/index.ts";
import {
  PersistenceConflictError,
  PersistenceDuplicateKeyError,
} from "../errors/families.ts";

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
  estimatedSpendUnits?: number | undefined;
  /** ISO currency for spend_units rules (skipped on mismatch). */
  currency?: string | undefined;
  modelAliasId?: string | undefined;
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
    spendUnits: number;
    currency: string;
    modelAliasId?: string | undefined;
  };
  occurredAt?: Date | undefined;
  /** Optional transaction session — passed to the counter bulk upsert. */
  session?: ClientSession | undefined;
};

/** One counter hold from preflight reservation. */
export type LimitHold = {
  readonly ruleId: string;
  readonly dimension: RateLimitRule["dimension"];
  readonly windowSeconds: number;
  readonly bucketStart: Date;
  readonly scopeTarget: string | null;
  readonly reserved: number;
  readonly capValue: number;
};

/** Atomic rolling-limit hold; caller must settle or release. */
export type LimitReservation = {
  readonly organizationId: ObjectId;
  readonly customerId: ObjectId;
  readonly holds: readonly LimitHold[];
};

export type ReserveLimitsParams = {
  readonly organizationId: ObjectId;
  readonly customerId: ObjectId;
  readonly rules: readonly RateLimitRule[];
  readonly estimatedTokens?: number | undefined;
  readonly estimatedSpendUnits?: number | undefined;
  /** ISO currency for spend_units rules (skipped on mismatch). */
  readonly currency?: string | undefined;
  readonly modelAliasId?: string | undefined;
  readonly nowMs?: number | undefined;
  /** Skip writes (decision-only; same math as checkLimits). */
  readonly dryRun?: boolean | undefined;
};

export type SettleLimitsParams = {
  readonly reservation: LimitReservation | null | undefined;
  readonly organizationId: ObjectId;
  readonly customerId: ObjectId;
  readonly rules: readonly RateLimitRule[];
  readonly usage: RecordUsageParams["usage"];
  readonly occurredAt?: Date | undefined;
  readonly session?: ClientSession | undefined;
};

export type EnforceParams = {
  customerId: ObjectId;
  estimatedTokens?: number | undefined;
  estimatedSpendUnits?: number | undefined;
  currency?: string | undefined;
  modelAliasId?: string | undefined;
};

export type RateLimitIoError = MongoFailure | PersistenceDataError;

/** Bounded retries when concurrent reserves collide on the same bucket. */
const RESERVE_MAX_ATTEMPTS = 8;

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
    case "spend_units":
      // Org is single-currency; all spend counts toward the same stream.
      return usage.spendUnits;
  }
}

/**
 * Estimated admission increment for a rule.
 * - tokens / spend: conservative estimate (0 → skip until settle)
 * - requests: always 1 (known before provider)
 */
export function estimatedRuleIncrement(
  rule: RateLimitRule,
  estimates: {
    readonly estimatedTokens?: number | undefined;
    readonly estimatedSpendUnits?: number | undefined;
    readonly currency?: string | undefined;
  },
): number {
  switch (rule.dimension) {
    case "tokens":
      return Math.max(0, estimates.estimatedTokens ?? 0);
    case "requests":
      return 1;
    case "spend_units":
      return Math.max(0, estimates.estimatedSpendUnits ?? 0);
  }
}

/**
 * Whether a dimension may exceed its rolling cap after admission.
 * spend_units is money-like (soft); tokens/requests are hard non-negative
 * remaining capacity (window sum must stay ≤ cap).
 */
export function allowsCapOvershoot(
  dimension: RateLimitRule["dimension"],
): boolean {
  return dimension === "spend_units";
}

/** Remaining room under a hard cap given current window sum. Never negative. */
export function hardCapRoom(capValue: number, windowSum: number): number {
  return Math.max(0, capValue - Math.max(0, windowSum));
}

/**
 * Clamp a settle delta for a hard-cap dimension.
 * - delta ≤ 0 (release surplus): always apply as-is
 * - delta > 0 (claim extra): at most `room` (cap − windowSum)
 * Soft dimensions return delta unchanged.
 */
export function clampSettleDelta(params: {
  readonly dimension: RateLimitRule["dimension"];
  readonly delta: number;
  readonly capValue: number;
  readonly windowSum: number;
}): number {
  if (params.delta <= 0) return params.delta;
  if (allowsCapOvershoot(params.dimension)) return params.delta;
  const room = hardCapRoom(params.capValue, params.windowSum);
  return Math.min(params.delta, room);
}

/**
 * Scope target the rule applies to for this call, or null for customer/plan.
 * Returns undefined when the rule should be skipped for this request.
 *
 * Targeted model rules only apply when the request model matches
 * `rule.scopeTarget`. Untargeted model rules track per request model.
 */
export function resolveScopeTarget(
  rule: RateLimitRule,
  modelAliasId: string | undefined,
): string | null | undefined {
  switch (rule.scope) {
    case "customer":
    case "plan":
      return null;
    case "model": {
      if (rule.scopeTarget) {
        if (!modelAliasId || modelAliasId !== rule.scopeTarget) return undefined;
        return rule.scopeTarget;
      }
      return modelAliasId ?? undefined;
    }
  }
}

/**
 * Sub-bucket length for a rolling window. Buckets must be smaller than the
 * window so usage ages out gradually (fixed window size === bucket size
 * allows a ~2× burst at each boundary).
 */
export function bucketDurationSeconds(windowSeconds: number): number {
  if (windowSeconds <= 60) return 1;
  if (windowSeconds <= 3600) return 60;
  return 300;
}

/** Floor now to the current sub-bucket boundary for this window. */
export function bucketStartFor(nowMs: number, windowSeconds: number): Date {
  const bucket = bucketDurationSeconds(windowSeconds);
  return new Date(Math.floor(nowMs / 1000 / bucket) * bucket * 1000);
}

type CounterWrite = {
  dimension: string;
  windowSeconds: number;
  bucketStart: Date;
  scopeTarget: string | null;
  increment: number;
};

function counterWriteKey(e: Omit<CounterWrite, "increment">): string {
  return `${e.dimension}\0${e.windowSeconds}\0${e.bucketStart.getTime()}\0${e.scopeTarget ?? ""}`;
}

/**
 * One counter document per (dimension, window, bucket, scope). Never sum
 * duplicate increments for the same key (that would double-count usage).
 *
 * When two writes hit the same key (legacy overlapping rules), keep the more
 * restrictive positive claim (min) and the smaller release magnitude (max of
 * negatives, i.e. closer to zero). Equal values either way.
 */
export function coalesceCounterWrites(
  entries: readonly CounterWrite[],
): CounterWrite[] {
  const map = new Map<string, CounterWrite>();
  for (const e of entries) {
    const key = counterWriteKey(e);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, e);
      continue;
    }
    let increment: number;
    if (prev.increment >= 0 && e.increment >= 0) {
      increment = Math.min(prev.increment, e.increment);
    } else if (prev.increment <= 0 && e.increment <= 0) {
      increment = Math.max(prev.increment, e.increment);
    } else {
      // Mixed sign on one key is not expected; prefer the later absolute net
      // by summing then... no: keep first to avoid inventing semantics.
      increment = prev.increment;
    }
    map.set(key, { ...prev, increment });
  }
  return [...map.values()];
}

/**
 * Collapse active rules that share a config stream to the strictest cap.
 * Defense for legacy plan/customer data written before uniqueness validation.
 * Prefer lower capValue; tie-break keeps the earlier rule in iteration order.
 */
export function collapseRulesByStream(
  rules: readonly RateLimitRule[],
): RateLimitRule[] {
  const byStream = new Map<string, RateLimitRule>();
  for (const r of rules) {
    if (!r.active) continue;
    const key = rateLimitStreamKey(r);
    const prev = byStream.get(key);
    if (!prev || r.capValue < prev.capValue) {
      byStream.set(key, r);
    }
  }
  return [...byStream.values()];
}

function isRetryableReserveConflict(err: unknown): boolean {
  if (err instanceof PersistenceConflictError) return true;
  if (err instanceof PersistenceDuplicateKeyError) return true;
  if (typeof err === "object" && err !== null && "_tag" in err) {
    const tag = (err as { _tag: string })._tag;
    return (
      tag === "PersistenceConflictError" ||
      tag === "PersistenceDuplicateKeyError"
    );
  }
  return false;
}

/**
 * Effective rate-limit rules for a customer: active subscription plan
 * defaults merged with per-customer overrides (override wins by rule id),
 * then collapsed to one rule per stream (strictest cap) for legacy safety.
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

    return collapseRulesByStream([...byId.values()]);
  });

/**
 * Read-only enforcement check. For each rule, sums current window usage from
 * `rateLimitCounters` and verifies that adding the estimated increment would
 * not exceed the cap. Returns violated rules with retry hints. No writes.
 *
 * Prefer `reserveLimits` for admission — this remains for dry-run / preview.
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
      estimatedSpendUnits,
      currency,
      modelAliasId,
    } = params;
    const now = params.nowMs ?? Date.now();
    const usageRepo = yield* UsageRepo;
    const violated: ViolatedLimit[] = [];

    for (const rule of rules) {
      const target = resolveScopeTarget(rule, modelAliasId);
      if (target === undefined) continue;

      const increment = estimatedRuleIncrement(rule, {
        estimatedTokens,
        estimatedSpendUnits,
        currency,
      });
      // Zero-estimate token/spend rules are skipped at admission (nothing to
      // claim yet). Request rules always claim 1.
      if (increment <= 0) continue;

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
        // Rolling: capacity frees when the oldest contributing bucket ages out.
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

type PlannedHold = {
  rule: RateLimitRule;
  target: string | null;
  increment: number;
  bucketStart: Date;
  windowStart: Date;
};

function planHolds(params: {
  rules: readonly RateLimitRule[];
  estimatedTokens?: number | undefined;
  estimatedSpendUnits?: number | undefined;
  currency?: string | undefined;
  modelAliasId?: string | undefined;
  nowMs: number;
}): PlannedHold[] {
  const planned: PlannedHold[] = [];
  for (const rule of params.rules) {
    if (!rule.active) continue;
    const target = resolveScopeTarget(rule, params.modelAliasId);
    if (target === undefined) continue;
    const increment = estimatedRuleIncrement(rule, {
      estimatedTokens: params.estimatedTokens,
      estimatedSpendUnits: params.estimatedSpendUnits,
      currency: params.currency,
    });
    if (increment <= 0) continue;
    planned.push({
      rule,
      target,
      increment,
      bucketStart: bucketStartFor(params.nowMs, rule.windowSeconds),
      windowStart: new Date(params.nowMs - rule.windowSeconds * 1000),
    });
  }
  return planned;
}

/**
 * Atomic admission: for each applicable rule, under a transaction, sum the
 * rolling window and $inc the current bucket only if sum + estimate ≤ cap.
 * Concurrent reserves on the same bucket serialize via write conflicts + retry.
 *
 * Returns empty holds when no rule needs a claim (no rules / zero estimates).
 */
export const reserveLimits = (
  params: ReserveLimitsParams,
): Effect.Effect<
  | { ok: true; reservation: LimitReservation }
  | { ok: false; violated: ViolatedLimit[] },
  RateLimitIoError,
  UsageRepo | MongoDb
> =>
  Effect.gen(function* () {
    const nowMs = params.nowMs ?? Date.now();
    const planned = planHolds({
      rules: params.rules,
      estimatedTokens: params.estimatedTokens,
      estimatedSpendUnits: params.estimatedSpendUnits,
      currency: params.currency,
      modelAliasId: params.modelAliasId,
      nowMs,
    });

    const emptyReservation: LimitReservation = {
      organizationId: params.organizationId,
      customerId: params.customerId,
      holds: [],
    };

    if (planned.length === 0) {
      return { ok: true as const, reservation: emptyReservation };
    }

    if (params.dryRun) {
      const check = yield* checkLimits({
        customerId: params.customerId,
        rules: [...params.rules],
        estimatedTokens: params.estimatedTokens,
        estimatedSpendUnits: params.estimatedSpendUnits,
        currency: params.currency,
        modelAliasId: params.modelAliasId,
        nowMs,
      });
      if (!check.ok) {
        return { ok: false as const, violated: check.violated };
      }
      return {
        ok: true as const,
        reservation: {
          organizationId: params.organizationId,
          customerId: params.customerId,
          holds: planned.map((p) => ({
            ruleId: p.rule.id,
            dimension: p.rule.dimension,
            windowSeconds: p.rule.windowSeconds,
            bucketStart: p.bucketStart,
            scopeTarget: p.target,
            reserved: p.increment,
            capValue: p.rule.capValue,
          })),
        },
      };
    }

    let lastConflict: RateLimitIoError | null = null;
    for (let attempt = 0; attempt < RESERVE_MAX_ATTEMPTS; attempt++) {
      const attemptResult = yield* withMongoSession((session) =>
        Effect.gen(function* () {
          const usageRepo = yield* UsageRepo;
          const violated: ViolatedLimit[] = [];
          const holds: LimitHold[] = [];
          const entries: {
            dimension: string;
            windowSeconds: number;
            bucketStart: Date;
            scopeTarget: string | null;
            increment: number;
          }[] = [];

          for (const p of planned) {
            const docs = yield* usageRepo.findWindowCounters(
              {
                customerId: params.customerId,
                dimension: p.rule.dimension,
                windowSeconds: p.rule.windowSeconds,
                windowStart: p.windowStart,
                scopeTarget: p.target,
              },
              session,
            );

            let current = 0;
            let oldestBucketMs = nowMs;
            for (const d of docs) {
              current += d.count;
              const ms = d.bucketStart.getTime();
              if (ms < oldestBucketMs) oldestBucketMs = ms;
            }

            if (current + p.increment > p.rule.capValue) {
              const retryAfterSeconds = Math.max(
                1,
                p.rule.windowSeconds -
                  Math.floor((nowMs - oldestBucketMs) / 1000),
              );
              violated.push({
                rule: p.rule,
                current,
                cap: p.rule.capValue,
                retryAfterSeconds,
              });
              continue;
            }

            holds.push({
              ruleId: p.rule.id,
              dimension: p.rule.dimension,
              windowSeconds: p.rule.windowSeconds,
              bucketStart: p.bucketStart,
              scopeTarget: p.target,
              reserved: p.increment,
              capValue: p.rule.capValue,
            });
            entries.push({
              dimension: p.rule.dimension,
              windowSeconds: p.rule.windowSeconds,
              bucketStart: p.bucketStart,
              scopeTarget: p.target,
              increment: p.increment,
            });
          }

          if (violated.length > 0) {
            // Abort txn without writes by failing after checks (no upserts yet).
            return {
              kind: "violated" as const,
              violated,
            };
          }

          yield* usageRepo.bulkUpsertCounters({
            organizationId: params.organizationId,
            customerId: params.customerId,
            session,
            entries: coalesceCounterWrites(entries),
          });

          return {
            kind: "reserved" as const,
            reservation: {
              organizationId: params.organizationId,
              customerId: params.customerId,
              holds,
            } satisfies LimitReservation,
          };
        }),
      ).pipe(
        Effect.map((r) => ({ tag: "ok" as const, result: r })),
        Effect.catchAll((err) => {
          if (isRetryableReserveConflict(err)) {
            return Effect.succeed({
              tag: "conflict" as const,
              err: err as RateLimitIoError,
            });
          }
          return Effect.fail(err);
        }),
      );

      if (attemptResult.tag === "conflict") {
        lastConflict = attemptResult.err;
        continue;
      }

      const r = attemptResult.result;
      if (r.kind === "violated") {
        return { ok: false as const, violated: r.violated };
      }
      return { ok: true as const, reservation: r.reservation };
    }

    // Exhausted conflict retries — surface as system-level IO error.
    return yield* Effect.fail(
      lastConflict ??
        new PersistenceConflictError({
          code: "persistence_conflict",
          message: "Rate-limit reservation conflict",
          labels: [],
          retryClass: "transient",
        }),
    );
  });

/**
 * Reverse a preflight hold (provider failure / cancel / pre-commit abort).
 * Best-effort: floors each counter at 0.
 */
export const releaseLimits = (
  reservation: LimitReservation | null | undefined,
  session?: ClientSession,
): Effect.Effect<void, RateLimitIoError, UsageRepo> =>
  Effect.gen(function* () {
    if (!reservation || reservation.holds.length === 0) return;
    const entries = reservation.holds
      .filter((h) => h.reserved > 0)
      .map((h) => ({
        dimension: h.dimension,
        windowSeconds: h.windowSeconds,
        bucketStart: h.bucketStart,
        scopeTarget: h.scopeTarget,
        increment: -h.reserved,
      }));
    if (entries.length === 0) return;
    const repo = yield* UsageRepo;
    yield* repo.bulkUpsertCounters({
      organizationId: reservation.organizationId,
      customerId: reservation.customerId,
      ...(session !== undefined ? { session } : {}),
      entries: coalesceCounterWrites(entries),
    });
  });

/**
 * After provider success: adjust counters so each rule ends at actual usage
 * (clamped by dimension policy).
 *
 * For each hold: delta = actual − reserved (negative when estimate was
 * conservative — typical for tokens). Applied on the **same bucket** reserved
 * at preflight so mid-request window rolls do not orphan holds.
 *
 * Actual > reserved:
 *  - spend_units: soft — full overage applied (cap may be exceeded)
 *  - tokens / requests: hard — claim at most remaining room under cap
 *
 * No reservation (legacy / playground): increments current buckets with the
 * same hard/soft policy.
 */
export const settleLimits = (
  params: SettleLimitsParams,
): Effect.Effect<void, RateLimitIoError, UsageRepo> =>
  Effect.gen(function* () {
    const when = params.occurredAt ?? new Date();
    const nowMs = when.getTime();
    const holds = params.reservation?.holds ?? [];
    const holdByRuleId = new Map(holds.map((h) => [h.ruleId, h]));
    const repo = yield* UsageRepo;
    const orgId = params.reservation?.organizationId ?? params.organizationId;
    const customerId = params.reservation?.customerId ?? params.customerId;
    const session = params.session;

    const entries: {
      dimension: string;
      windowSeconds: number;
      bucketStart: Date;
      scopeTarget: string | null;
      increment: number;
    }[] = [];

    const consumedHoldIds = new Set<string>();

    const windowSum = (
      dimension: string,
      windowSeconds: number,
      scopeTarget: string | null,
    ) =>
      Effect.gen(function* () {
        const windowStart = new Date(nowMs - windowSeconds * 1000);
        const docs = yield* repo.findWindowCounters(
          {
            customerId,
            dimension,
            windowSeconds,
            windowStart,
            scopeTarget,
          },
          session,
        );
        let sum = 0;
        for (const d of docs) sum += d.count;
        return sum;
      });

    for (const rule of params.rules) {
      if (!rule.active) continue;
      const actual = ruleIncrement(rule, params.usage);
      const target = resolveScopeTarget(rule, params.usage.modelAliasId);
      if (target === undefined) continue;

      const hold = holdByRuleId.get(rule.id);
      if (hold) {
        consumedHoldIds.add(rule.id);
        const rawDelta = actual - hold.reserved;
        if (rawDelta === 0) continue;

        let delta = rawDelta;
        // Hard dims: re-read window (includes our hold) before claiming extra.
        if (rawDelta > 0 && !allowsCapOvershoot(hold.dimension)) {
          const sum = yield* windowSum(
            hold.dimension,
            hold.windowSeconds,
            hold.scopeTarget,
          );
          delta = clampSettleDelta({
            dimension: hold.dimension,
            delta: rawDelta,
            capValue: hold.capValue,
            windowSum: sum,
          });
          if (delta === 0) continue;
        }

        entries.push({
          dimension: hold.dimension,
          windowSeconds: hold.windowSeconds,
          bucketStart: hold.bucketStart,
          scopeTarget: hold.scopeTarget,
          increment: delta,
        });
        continue;
      }

      // No hold for this rule (e.g. zero estimate at preflight for tokens).
      if (actual <= 0) continue;

      let increment = actual;
      if (!allowsCapOvershoot(rule.dimension)) {
        const sum = yield* windowSum(
          rule.dimension,
          rule.windowSeconds,
          target,
        );
        increment = Math.min(actual, hardCapRoom(rule.capValue, sum));
        if (increment <= 0) continue;
      }

      entries.push({
        dimension: rule.dimension,
        windowSeconds: rule.windowSeconds,
        bucketStart: bucketStartFor(nowMs, rule.windowSeconds),
        scopeTarget: target ?? null,
        increment,
      });
    }

    // Orphan holds (rule removed mid-flight): full release.
    for (const h of holds) {
      if (consumedHoldIds.has(h.ruleId)) continue;
      if (h.reserved <= 0) continue;
      entries.push({
        dimension: h.dimension,
        windowSeconds: h.windowSeconds,
        bucketStart: h.bucketStart,
        scopeTarget: h.scopeTarget,
        increment: -h.reserved,
      });
    }

    if (entries.length === 0) return;

    yield* repo.bulkUpsertCounters({
      organizationId: orgId,
      customerId,
      ...(session !== undefined ? { session } : {}),
      entries: coalesceCounterWrites(entries),
    });
  });

/**
 * Record actual usage into bucketed rolling counters (no prior reservation).
 * Prefer settleLimits when a LimitReservation exists.
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

      const target = resolveScopeTarget(rule, usage.modelAliasId);
      if (target === undefined) continue;

      entries.push({
        dimension: rule.dimension,
        windowSeconds: rule.windowSeconds,
        bucketStart: bucketStartFor(nowMs, rule.windowSeconds),
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
      entries: coalesceCounterWrites(entries),
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
      estimatedSpendUnits,
      currency,
      modelAliasId,
    } = params;
    const rules = yield* getEffectiveRules(customerId);
    if (rules.length === 0) return { ok: true as const };
    const result = yield* checkLimits({
      customerId,
      rules,
      estimatedTokens,
      estimatedSpendUnits,
      currency,
      modelAliasId,
    });
    return result.ok
      ? { ok: true as const }
      : { ok: false as const, violated: result.violated };
  });

// ---------------------------------------------------------------------------
// Outbox serialization helpers (JSON-safe context)
// ---------------------------------------------------------------------------

export type LimitHoldWire = {
  readonly ruleId: string;
  readonly dimension: RateLimitRule["dimension"];
  readonly windowSeconds: number;
  readonly bucketStart: string;
  readonly scopeTarget: string | null;
  readonly reserved: number;
  readonly capValue: number;
};

export function serializeLimitReservation(
  reservation: LimitReservation | null | undefined,
): LimitHoldWire[] | undefined {
  if (!reservation || reservation.holds.length === 0) return undefined;
  return reservation.holds.map((h) => ({
    ruleId: h.ruleId,
    dimension: h.dimension,
    windowSeconds: h.windowSeconds,
    bucketStart: h.bucketStart.toISOString(),
    scopeTarget: h.scopeTarget,
    reserved: h.reserved,
    capValue: h.capValue,
  }));
}

export function parseLimitReservation(params: {
  organizationId: ObjectId;
  customerId: ObjectId;
  wire: unknown;
}): LimitReservation | null {
  if (!Array.isArray(params.wire) || params.wire.length === 0) return null;
  const holds: LimitHold[] = [];
  for (const raw of params.wire) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.ruleId !== "string") continue;
    if (
      o.dimension !== "tokens" &&
      o.dimension !== "requests" &&
      o.dimension !== "spend_units"
    ) {
      continue;
    }
    if (typeof o.windowSeconds !== "number" || !Number.isSafeInteger(o.windowSeconds)) {
      continue;
    }
    if (typeof o.reserved !== "number" || !Number.isSafeInteger(o.reserved)) {
      continue;
    }
    if (typeof o.capValue !== "number") continue;
    const bucketStart =
      typeof o.bucketStart === "string" || o.bucketStart instanceof Date
        ? new Date(o.bucketStart as string | Date)
        : null;
    if (!bucketStart || Number.isNaN(bucketStart.getTime())) continue;
    const scopeTarget =
      o.scopeTarget === null || typeof o.scopeTarget === "string"
        ? (o.scopeTarget as string | null)
        : null;
    holds.push({
      ruleId: o.ruleId,
      dimension: o.dimension,
      windowSeconds: o.windowSeconds,
      bucketStart,
      scopeTarget,
      reserved: Math.max(0, o.reserved),
      capValue: o.capValue,
    });
  }
  if (holds.length === 0) return null;
  return {
    organizationId: params.organizationId,
    customerId: params.customerId,
    holds,
  };
}
