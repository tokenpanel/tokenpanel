/**
 * Balance preflight / reserve / release / debit workflow (9.3).
 *
 * Single application Effect path — no Promise dual-path.
 * Every org uses atomic reservedUnits holds before provider calls.
 * Rolling rate limits use the same admission pattern via reserveLimits.
 */

import { Effect } from "effect";
import type { ObjectId } from "mongodb";
import type { ModelDoc, RateLimitRule } from "@tokenpanel/db";
import {
  AuthorizationError,
  InsufficientBalanceError,
  NotFoundError,
  RateLimitExceededError,
  SystemError,
} from "../../errors/families.ts";
import { Clock } from "../../runtime/services/clock.ts";
import {
  getEffectiveRules,
  releaseLimits,
  reserveLimits,
  type LimitReservation,
  type ViolatedLimit,
} from "../../lib/rate-limits.ts";
import { CustomersRepo } from "../../infrastructure/mongo/repositories/customers.ts";
import { ModelsRepo } from "../../infrastructure/mongo/repositories/models.ts";
import type { PlansRepo } from "../../infrastructure/mongo/repositories/plans.ts";
import type { UsageRepo } from "../../infrastructure/mongo/repositories/usage.ts";
import type { MongoDb } from "../../runtime/services/mongo-db.ts";
import {
  releaseBalanceReservation,
  reserveBalance,
  settleBalanceWithReservation,
} from "../../services/reservation.ts";
import { estimatePreFlightSpend } from "./estimate.ts";
import {
  availableUnits,
  wouldReserveSucceed,
  type BalanceSnapshot,
} from "./reservation.ts";

export type BalanceReservation = {
  reservedUnits: number;
  customerId: ObjectId;
  organizationId: ObjectId;
};

export type { LimitReservation };

export type PreFlightResult = {
  readonly model: ModelDoc;
  readonly rules: readonly RateLimitRule[];
  /** Non-null when balance was held (caller must settle or release). */
  readonly reservation: BalanceReservation | null;
  /**
   * Rolling-limit holds (may be empty holds). Non-null when rules were
   * evaluated; caller must settleLimits or releaseLimits.
   */
  readonly limitReservation: LimitReservation | null;
  readonly estimatedTokens: number;
  readonly estimatedSpendUnits: number;
};

export type BillingWorkflowError =
  | AuthorizationError
  | InsufficientBalanceError
  | RateLimitExceededError
  | NotFoundError
  | SystemError;

export type BillingWorkflowServices =
  | Clock
  | CustomersRepo
  | ModelsRepo
  | PlansRepo
  | UsageRepo
  | MongoDb;

function mapRateLimit(v: ViolatedLimit): RateLimitExceededError {
  return new RateLimitExceededError({
    code: "rate_limited",
    message: `Rate limit exceeded: ${v.rule.dimension} cap ${v.cap} in ${v.rule.windowSeconds}s window`,
    retryAfterSeconds: v.retryAfterSeconds,
    dimension: v.rule.dimension,
    cap: v.cap,
    current: v.current,
    windowSeconds: v.rule.windowSeconds,
  });
}

function mapSystem(message: string) {
  return (e: unknown) =>
    new SystemError({
      code: "system_error",
      message,
      diagnostic: e instanceof Error ? e.message : String(e),
    });
}

function failReserveDecision(
  snap: BalanceSnapshot,
  needUnits: number,
  currency: string,
): InsufficientBalanceError {
  const decision = wouldReserveSucceed(snap, needUnits, currency);
  if (!decision.ok && decision.reason === "currency_mismatch") {
    return new InsufficientBalanceError({
      code: "currency_mismatch",
      message: "Customer balance currency does not match model currency",
      balanceCurrency: snap.currency,
      modelCurrency: currency,
    });
  }
  return new InsufficientBalanceError({
    code: "insufficient_balance",
    message: "Insufficient available balance to complete request",
    requiredUnits: needUnits,
    currency,
    balanceUnits: availableUnits(snap),
  });
}

/** Resolve active model by alias (Effect). */
export const resolveModelOp = (
  orgId: ObjectId,
  aliasId: string,
): Effect.Effect<ModelDoc, NotFoundError | SystemError, ModelsRepo> =>
  Effect.gen(function* () {
    const models = yield* ModelsRepo;
    const model = yield* models
      .findModelByAlias(orgId, aliasId)
      .pipe(Effect.mapError(mapSystem("Failed to load model")));
    if (!model || !model.active) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "model_not_found",
          message: `Model '${aliasId}' not found or inactive`,
          resource: "model",
        }),
      );
    }
    // Effect Schema docs are structurally compatible with domain ModelDoc.
    return model as ModelDoc;
  });

/**
 * Application pre-flight: model access, atomic rate-limit reserve (Clock),
 * atomic balance reserve before the provider call.
 *
 * When `model` is omitted, loads via ModelsRepo from orgId + aliasId.
 *
 * Order: limits first, then balance. If balance fails after limits were
 * reserved, limit holds are released before returning the error.
 */
export const preFlightWorkflow = (params: {
  readonly orgId: ObjectId;
  readonly customerId: ObjectId;
  readonly apiKeyModelWhitelist: readonly string[];
  readonly aliasId: string;
  readonly model?: ModelDoc | undefined;
  readonly estimatedPromptTokens?: number | undefined;
  readonly maxCompletionTokens?: number | undefined;
  /** Inject rules to skip DB (tests). */
  readonly rules?: readonly RateLimitRule[] | undefined;
  /** Inject balance snapshot to skip customer read (tests). */
  readonly balanceSnapshot?: BalanceSnapshot | undefined;
  /** Skip atomic reserve write (decision-only mode for pure tests). */
  readonly dryRun?: boolean | undefined;
}): Effect.Effect<
  PreFlightResult,
  BillingWorkflowError,
  BillingWorkflowServices
> =>
  Effect.gen(function* () {
    if (
      params.apiKeyModelWhitelist.length > 0 &&
      !params.apiKeyModelWhitelist.includes(params.aliasId)
    ) {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "model_not_allowed",
          message: `Your API key does not allow model '${params.aliasId}'`,
        }),
      );
    }

    const model =
      params.model ?? (yield* resolveModelOp(params.orgId, params.aliasId));

    const clock = yield* Clock;

    const estimate = estimatePreFlightSpend({
      model,
      estimatedPromptTokens: params.estimatedPromptTokens ?? 0,
      maxCompletionTokens: params.maxCompletionTokens,
    });

    const rules =
      params.rules ??
      (yield* getEffectiveRules(params.customerId).pipe(
        Effect.mapError(mapSystem("Failed to load rate-limit rules")),
      ));

    let limitReservation: LimitReservation | null = null;
    if (rules.length > 0) {
      const limitResult = yield* reserveLimits({
        organizationId: params.orgId,
        customerId: params.customerId,
        rules,
        estimatedTokens: estimate.estimatedTokens,
        estimatedSpendUnits: estimate.estimatedSpendUnits,
        currency: estimate.currency,
        modelAliasId: params.aliasId,
        nowMs: clock.nowMs(),
        dryRun: params.dryRun,
      }).pipe(Effect.mapError(mapSystem("Rate-limit reservation failed")));
      if (!limitResult.ok) {
        const v = limitResult.violated[0];
        if (v) return yield* Effect.fail(mapRateLimit(v));
        return yield* Effect.fail(
          new RateLimitExceededError({
            code: "rate_limited",
            message: "Rate limit exceeded",
            retryAfterSeconds: 1,
          }),
        );
      }
      limitReservation = limitResult.reservation;
    }

    let reservation: BalanceReservation | null = null;
    if (estimate.estimatedSpendUnits > 0) {
      let snap: BalanceSnapshot;
      if (params.balanceSnapshot) {
        snap = params.balanceSnapshot;
      } else {
        const customers = yield* CustomersRepo;
        const customer = yield* customers
          .findByIdAnyOrg(params.customerId)
          .pipe(Effect.mapError(mapSystem("Failed to load customer balance")));
        if (!customer) {
          // Release limit holds before failing.
          if (limitReservation && !params.dryRun) {
            yield* releaseLimits(limitReservation).pipe(
              Effect.catchAll(() => Effect.void),
            );
          }
          return yield* Effect.fail(
            new AuthorizationError({
              code: "customer_not_found",
              message: "Customer not found",
            }),
          );
        }
        snap = {
          amountUnits: customer.balance.amountUnits,
          reservedUnits: customer.balance.reservedUnits ?? 0,
          currency: customer.balance.currency,
        };
      }

      if (params.dryRun) {
        const decision = wouldReserveSucceed(
          snap,
          estimate.estimatedSpendUnits,
          estimate.currency,
        );
        if (!decision.ok) {
          return yield* Effect.fail(
            failReserveDecision(
              snap,
              estimate.estimatedSpendUnits,
              estimate.currency,
            ),
          );
        }
        reservation = {
          reservedUnits: estimate.estimatedSpendUnits,
          customerId: params.customerId,
          organizationId: params.orgId,
        };
      } else {
        const held = yield* reserveBalance({
          customerId: params.customerId,
          organizationId: params.orgId,
          needUnits: estimate.estimatedSpendUnits,
          currency: estimate.currency,
        }).pipe(Effect.mapError(mapSystem("Balance reservation failed")));
        if (!held.reserved) {
          if (limitReservation) {
            yield* releaseLimits(limitReservation).pipe(
              Effect.catchAll(() => Effect.void),
            );
          }
          return yield* Effect.fail(
            failReserveDecision(
              snap,
              estimate.estimatedSpendUnits,
              estimate.currency,
            ),
          );
        }
        if (held.reservedUnits > 0) {
          reservation = {
            reservedUnits: held.reservedUnits,
            customerId: params.customerId,
            organizationId: params.orgId,
          };
        }
      }
    }

    return {
      model,
      rules,
      reservation,
      limitReservation,
      estimatedTokens: estimate.estimatedTokens,
      estimatedSpendUnits: estimate.estimatedSpendUnits,
    };
  });

/** Best-effort release of a preFlight balance hold. */
export const releaseReservationWorkflow = (
  reservation: BalanceReservation | null | undefined,
): Effect.Effect<void, never, CustomersRepo> =>
  Effect.gen(function* () {
    if (!reservation || reservation.reservedUnits <= 0) return;
    yield* releaseBalanceReservation({
      customerId: reservation.customerId,
      organizationId: reservation.organizationId,
      reservedUnits: reservation.reservedUnits,
    }).pipe(Effect.catchAll(() => Effect.succeed(false)));
  });

/** Best-effort release of a preFlight rolling-limit hold. */
export const releaseLimitReservationWorkflow = (
  limitReservation: LimitReservation | null | undefined,
): Effect.Effect<void, never, UsageRepo> =>
  Effect.gen(function* () {
    if (!limitReservation || limitReservation.holds.length === 0) return;
    yield* releaseLimits(limitReservation).pipe(
      Effect.catchAll(() => Effect.void),
    );
  });

/**
 * Best-effort release of balance + limit holds (cancel / pre-commit fail).
 */
export const releaseAllPreflightHolds = (params: {
  readonly reservation?: BalanceReservation | null | undefined;
  readonly limitReservation?: LimitReservation | null | undefined;
}): Effect.Effect<void, never, CustomersRepo | UsageRepo> =>
  Effect.gen(function* () {
    yield* releaseReservationWorkflow(params.reservation);
    yield* releaseLimitReservationWorkflow(params.limitReservation);
  });

/** Settle after hold: debit actual + release reserved. */
export const debitWithReservationWorkflow = (params: {
  readonly customerId: ObjectId;
  readonly organizationId: ObjectId;
  readonly priceUnits: number;
  readonly reservedUnits: number;
  readonly currency: string;
}): Effect.Effect<boolean, SystemError, CustomersRepo> =>
  settleBalanceWithReservation(params).pipe(
    Effect.mapError(mapSystem("Balance settle with reservation failed")),
  );
