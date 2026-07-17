/**
 * Balance preflight / reserve / release / debit workflow (9.3).
 *
 * Single application Effect path — no Promise dual-path.
 * Every org uses atomic reservedMinor holds before provider calls.
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
  checkLimits,
  getEffectiveRules,
  type ViolatedLimit,
} from "../../lib/rate-limits.ts";
import { CustomersRepo } from "../../infrastructure/mongo/repositories/customers.ts";
import { ModelsRepo } from "../../infrastructure/mongo/repositories/models.ts";
import type { PlansRepo } from "../../infrastructure/mongo/repositories/plans.ts";
import type { UsageRepo } from "../../infrastructure/mongo/repositories/usage.ts";
import {
  releaseBalanceReservation,
  reserveBalance,
  settleBalanceWithReservation,
} from "../../services/reservation.ts";
import { estimatePreFlightSpend } from "./estimate.ts";
import {
  availableMinor,
  wouldReserveSucceed,
  type BalanceSnapshot,
} from "./reservation.ts";

export type BalanceReservation = {
  reservedMinor: number;
  customerId: ObjectId;
  organizationId: ObjectId;
};

export type PreFlightResult = {
  readonly model: ModelDoc;
  readonly rules: readonly RateLimitRule[];
  /** Non-null when balance was held (caller must settle or release). */
  readonly reservation: BalanceReservation | null;
  readonly estimatedTokens: number;
  readonly estimatedSpendMinor: number;
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
  | UsageRepo;

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
  needMinor: number,
  currency: string,
): InsufficientBalanceError {
  const decision = wouldReserveSucceed(snap, needMinor, currency);
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
    requiredMinor: needMinor,
    currency,
    balanceMinor: availableMinor(snap),
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
 * Application pre-flight: model access, rate limits (Clock), atomic balance
 * reserve before the provider call.
 *
 * When `model` is omitted, loads via ModelsRepo from orgId + aliasId.
 */
export const preFlightWorkflow = (params: {
  readonly orgId: ObjectId;
  readonly customerId: ObjectId;
  readonly apiKeyModelWhitelist: readonly string[];
  readonly aliasId: string;
  readonly model?: ModelDoc | undefined;
  readonly estimatedPromptTokens?: number | undefined;
  readonly maxCompletionTokens?: number | undefined;
  readonly scopeTarget?: string | undefined;
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

    if (rules.length > 0 && estimate.estimatedTokens > 0) {
      const limitResult = yield* checkLimits({
        customerId: params.customerId,
        rules: [...rules],
        estimatedTokens: estimate.estimatedTokens,
        estimatedSpendMinor: estimate.estimatedSpendMinor,
        modelAliasId: params.aliasId,
        scopeTarget: params.scopeTarget,
        nowMs: clock.nowMs(),
      }).pipe(Effect.mapError(mapSystem("Rate-limit evaluation failed")));
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
    }

    let reservation: BalanceReservation | null = null;
    if (estimate.estimatedSpendMinor > 0) {
      let snap: BalanceSnapshot;
      if (params.balanceSnapshot) {
        snap = params.balanceSnapshot;
      } else {
        const customers = yield* CustomersRepo;
        const customer = yield* customers
          .findByIdAnyOrg(params.customerId)
          .pipe(Effect.mapError(mapSystem("Failed to load customer balance")));
        if (!customer) {
          return yield* Effect.fail(
            new AuthorizationError({
              code: "customer_not_found",
              message: "Customer not found",
            }),
          );
        }
        snap = {
          amountMinor: customer.balance.amountMinor,
          reservedMinor: customer.balance.reservedMinor ?? 0,
          currency: customer.balance.currency,
        };
      }

      if (params.dryRun) {
        const decision = wouldReserveSucceed(
          snap,
          estimate.estimatedSpendMinor,
          estimate.currency,
        );
        if (!decision.ok) {
          return yield* Effect.fail(
            failReserveDecision(
              snap,
              estimate.estimatedSpendMinor,
              estimate.currency,
            ),
          );
        }
        reservation = {
          reservedMinor: estimate.estimatedSpendMinor,
          customerId: params.customerId,
          organizationId: params.orgId,
        };
      } else {
        const held = yield* reserveBalance({
          customerId: params.customerId,
          organizationId: params.orgId,
          needMinor: estimate.estimatedSpendMinor,
          currency: estimate.currency,
        }).pipe(Effect.mapError(mapSystem("Balance reservation failed")));
        if (!held.reserved) {
          return yield* Effect.fail(
            failReserveDecision(
              snap,
              estimate.estimatedSpendMinor,
              estimate.currency,
            ),
          );
        }
        if (held.reservedMinor > 0) {
          reservation = {
            reservedMinor: held.reservedMinor,
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
      estimatedTokens: estimate.estimatedTokens,
      estimatedSpendMinor: estimate.estimatedSpendMinor,
    };
  });

/** Best-effort release of a preFlight hold. */
export const releaseReservationWorkflow = (
  reservation: BalanceReservation | null | undefined,
): Effect.Effect<void, never, CustomersRepo> =>
  Effect.gen(function* () {
    if (!reservation || reservation.reservedMinor <= 0) return;
    yield* releaseBalanceReservation({
      customerId: reservation.customerId,
      organizationId: reservation.organizationId,
      reservedMinor: reservation.reservedMinor,
    }).pipe(Effect.catchAll(() => Effect.succeed(false)));
  });

/** Settle after hold: debit actual + release reserved. */
export const debitWithReservationWorkflow = (params: {
  readonly customerId: ObjectId;
  readonly organizationId: ObjectId;
  readonly priceMinor: number;
  readonly reservedMinor: number;
  readonly currency: string;
}): Effect.Effect<boolean, SystemError, CustomersRepo> =>
  settleBalanceWithReservation(params).pipe(
    Effect.mapError(mapSystem("Balance settle with reservation failed")),
  );
