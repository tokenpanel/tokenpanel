/**
 * Rate-limit evaluation Effect operations (task 9.2).
 * Pure rule helpers re-exported; I/O uses PlansRepo + UsageRepo + Clock.
 */

import { Effect } from "effect";
import type { ObjectId } from "mongodb";
import type { RateLimitRule } from "@tokenpanel/db";
import { RateLimitExceededError, SystemError } from "../../errors/families.ts";
import { Clock } from "../../runtime/services/clock.ts";
import {
  checkLimits,
  getEffectiveRules,
  recordUsage,
  releaseLimits,
  reserveLimits,
  resolveScopeTarget,
  ruleIncrement,
  settleLimits,
  windowSecondsToHuman,
  type LimitReservation,
  type RecordUsageParams,
  type ViolatedLimit,
} from "../../lib/rate-limits.ts";
import type { PlansRepo } from "../../infrastructure/mongo/repositories/plans.ts";
import type { UsageRepo } from "../../infrastructure/mongo/repositories/usage.ts";
import type { MongoDb } from "../../runtime/services/mongo-db.ts";

export {
  windowSecondsToHuman,
  ruleIncrement,
  resolveScopeTarget,
  type LimitReservation,
  type ViolatedLimit,
};

export type LimitsError = RateLimitExceededError | SystemError;

export type RateLimitCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violated: readonly ViolatedLimit[] };

function mapIoError(message: string) {
  return (e: unknown) =>
    new SystemError({
      code: "system_error",
      message,
      diagnostic: e instanceof Error ? e.message : String(e),
    });
}

/** Load effective active rules (plan defaults + customer overrides by id). */
export const getEffectiveRulesOp = (
  customerId: ObjectId,
): Effect.Effect<readonly RateLimitRule[], SystemError, PlansRepo> =>
  getEffectiveRules(customerId).pipe(
    Effect.mapError(mapIoError("Failed to load effective rate-limit rules")),
  );

/**
 * Read-only rate-limit evaluation with deterministic Clock.
 * No writes.
 */
export const evaluateRateLimits = (params: {
  readonly customerId: ObjectId;
  readonly rules: readonly RateLimitRule[];
  readonly estimatedTokens?: number | undefined;
  readonly estimatedSpendMinor?: number | undefined;
  readonly currency?: string | undefined;
  readonly modelAliasId?: string | undefined;
}): Effect.Effect<RateLimitCheckResult, SystemError, Clock | UsageRepo> =>
  Effect.gen(function* () {
    const clock = yield* Clock;
    const result = yield* checkLimits({
      customerId: params.customerId,
      rules: [...params.rules],
      estimatedTokens: params.estimatedTokens,
      estimatedSpendMinor: params.estimatedSpendMinor,
      currency: params.currency,
      modelAliasId: params.modelAliasId,
      nowMs: clock.nowMs(),
    }).pipe(Effect.mapError(mapIoError("Rate-limit check failed")));
    if (result.ok) return { ok: true as const };
    return { ok: false as const, violated: result.violated };
  });

/**
 * Enforce: load rules + evaluate; fail with RateLimitExceededError on first hit.
 */
export const enforceRateLimits = (params: {
  readonly customerId: ObjectId;
  readonly estimatedTokens?: number | undefined;
  readonly estimatedSpendMinor?: number | undefined;
  readonly currency?: string | undefined;
  readonly modelAliasId?: string | undefined;
}): Effect.Effect<
  { readonly ok: true; readonly rules: readonly RateLimitRule[] },
  LimitsError,
  Clock | PlansRepo | UsageRepo
> =>
  Effect.gen(function* () {
    const rules = yield* getEffectiveRulesOp(params.customerId);
    if (rules.length === 0) return { ok: true as const, rules };
    const result = yield* evaluateRateLimits({
      customerId: params.customerId,
      rules,
      estimatedTokens: params.estimatedTokens,
      estimatedSpendMinor: params.estimatedSpendMinor,
      currency: params.currency,
      modelAliasId: params.modelAliasId,
    });
    if (!result.ok) {
      const v = result.violated[0];
      if (v) {
        return yield* Effect.fail(
          new RateLimitExceededError({
            code: "rate_limited",
            message: `Rate limit exceeded: ${v.rule.dimension} cap ${v.cap} in ${v.rule.windowSeconds}s window`,
            retryAfterSeconds: v.retryAfterSeconds,
            dimension: v.rule.dimension,
            cap: v.cap,
            current: v.current,
            windowSeconds: v.rule.windowSeconds,
          }),
        );
      }
      return yield* Effect.fail(
        new RateLimitExceededError({
          code: "rate_limited",
          message: "Rate limit exceeded",
          retryAfterSeconds: 1,
        }),
      );
    }
    return { ok: true as const, rules };
  });

/** Pure retry-after calculation (matches checkLimits). */
export function computeRetryAfterSeconds(params: {
  readonly nowMs: number;
  readonly windowSeconds: number;
  readonly oldestBucketMs: number;
}): number {
  return Math.max(
    1,
    params.windowSeconds -
      Math.floor((params.nowMs - params.oldestBucketMs) / 1000),
  );
}

/** Record usage counters (post-settle, no prior reservation). */
export const recordRateLimitUsage = (
  params: Omit<RecordUsageParams, "db">,
): Effect.Effect<void, SystemError, UsageRepo> =>
  recordUsage({
    organizationId: params.organizationId,
    customerId: params.customerId,
    rules: params.rules,
    usage: params.usage,
    occurredAt: params.occurredAt,
    ...(params.session !== undefined ? { session: params.session } : {}),
  }).pipe(Effect.mapError(mapIoError("Rate-limit counter write failed")));

/**
 * Atomic admission reserve for rolling limits.
 * Prefer this over evaluateRateLimits for request admission.
 */
export const reserveRateLimits = (params: {
  readonly organizationId: ObjectId;
  readonly customerId: ObjectId;
  readonly rules: readonly RateLimitRule[];
  readonly estimatedTokens?: number | undefined;
  readonly estimatedSpendMinor?: number | undefined;
  readonly currency?: string | undefined;
  readonly modelAliasId?: string | undefined;
  readonly dryRun?: boolean | undefined;
}): Effect.Effect<
  | { readonly ok: true; readonly reservation: LimitReservation }
  | { readonly ok: false; readonly violated: readonly ViolatedLimit[] },
  SystemError,
  Clock | UsageRepo | MongoDb
> =>
  Effect.gen(function* () {
    const clock = yield* Clock;
    return yield* reserveLimits({
      organizationId: params.organizationId,
      customerId: params.customerId,
      rules: params.rules,
      estimatedTokens: params.estimatedTokens,
      estimatedSpendMinor: params.estimatedSpendMinor,
      currency: params.currency,
      modelAliasId: params.modelAliasId,
      nowMs: clock.nowMs(),
      dryRun: params.dryRun,
    }).pipe(Effect.mapError(mapIoError("Rate-limit reservation failed")));
  });

/** Best-effort release of a limit reservation. */
export const releaseRateLimitReservation = (
  reservation: LimitReservation | null | undefined,
): Effect.Effect<void, never, UsageRepo> =>
  releaseLimits(reservation).pipe(Effect.catchAll(() => Effect.void));

/** Adjust counters after success: actual − reserved (or full record if no hold). */
export const settleRateLimitUsage = (params: {
  readonly reservation?: LimitReservation | null | undefined;
  readonly organizationId: ObjectId;
  readonly customerId: ObjectId;
  readonly rules: readonly RateLimitRule[];
  readonly usage: RecordUsageParams["usage"];
  readonly occurredAt?: Date | undefined;
  readonly session?: RecordUsageParams["session"];
}): Effect.Effect<void, SystemError, UsageRepo> =>
  settleLimits({
    reservation: params.reservation,
    organizationId: params.organizationId,
    customerId: params.customerId,
    rules: params.rules,
    usage: params.usage,
    occurredAt: params.occurredAt,
    ...(params.session !== undefined ? { session: params.session } : {}),
  }).pipe(Effect.mapError(mapIoError("Rate-limit settle failed")));
