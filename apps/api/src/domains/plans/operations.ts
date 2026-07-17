/**
 * Plan / subscription / rate-limit / budget operations (task 8.3).
 */
import { Effect } from "effect";
import type {
  SubscriptionPlanDoc,
  SubscriptionDoc,
  RateLimitRule,
  RateLimitRuleInput,
  CustomerLimitDoc,
  BudgetDoc,
} from "@tokenpanel/db";
import {
  ConflictError,
  InvalidStateError,
  NotFoundError,
} from "../../errors/families.ts";
import type { HexId, RepoError } from "../ports/common.ts";
import { PlanRepository } from "../ports/plan-repository.ts";
import { CustomerRepository } from "../ports/customer-repository.ts";
import { Clock } from "../../runtime/services/clock.ts";
import { Crypto } from "../../runtime/services/crypto.ts";
import { addInterval } from "./interval.ts";

export type PlanDomainError =
  | ConflictError
  | InvalidStateError
  | NotFoundError
  | RepoError;

/** Generate a short stable rule id (12 hex chars). */
export function genRuleIdFromToken(hex: string): string {
  return hex.slice(0, 12);
}

export function normalizeRules(
  rules: readonly RateLimitRuleInput[],
  genId: () => string,
): RateLimitRule[] {
  return rules.map((r, i) => ({
    id: r.id ?? genId(),
    windowSeconds: r.windowSeconds,
    dimension: r.dimension,
    capValue: r.capValue,
    scope: r.scope ?? "customer",
    scopeTarget: r.scopeTarget ?? null,
    currency: r.currency ?? null,
    active: r.active ?? true,
    // preserve sort order via map index (no _index leak)
    ...(i >= 0 ? {} : {}),
  }));
}

export const listPlans = (
  organizationId: HexId,
): Effect.Effect<readonly SubscriptionPlanDoc[], RepoError, PlanRepository> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    return yield* plans.listPlans(organizationId);
  });

export const getPlan = (input: {
  readonly organizationId: HexId;
  readonly planId: HexId;
}): Effect.Effect<SubscriptionPlanDoc, PlanDomainError, PlanRepository> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    const doc = yield* plans.findPlan(input.organizationId, input.planId);
    if (!doc) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Plan not found",
          resource: "plan",
          id: input.planId,
        }),
      );
    }
    return doc;
  });

export const createPlan = (input: {
  readonly organizationId: HexId;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly price: { readonly amountMinor: number; readonly currency: string };
  readonly interval: string;
  readonly intervalCount: number;
  readonly includedCredit?:
    | { readonly amountMinor: number; readonly currency: string }
    | undefined;
  readonly includedTokens?: number | undefined;
  readonly rateLimits?: readonly RateLimitRuleInput[] | undefined;
}): Effect.Effect<
  SubscriptionPlanDoc,
  PlanDomainError,
  PlanRepository | Crypto
> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    const crypto = yield* Crypto;
    const rateLimits = normalizeRules(input.rateLimits ?? [], () =>
      // sync-ish: Effect.gen can't call sync crypto without yield — pre-map below
      "",
    );
    // Re-normalize with real ids
    const withIds: RateLimitRule[] = [];
    for (const r of input.rateLimits ?? []) {
      const id =
        r.id ?? genRuleIdFromToken(yield* crypto.randomToken(6));
      withIds.push({
        id,
        windowSeconds: r.windowSeconds,
        dimension: r.dimension,
        capValue: r.capValue,
        scope: r.scope ?? "customer",
        scopeTarget: r.scopeTarget ?? null,
        currency: r.currency ?? null,
        active: r.active ?? true,
      });
    }
    void rateLimits;
    return yield* plans.insertPlan({
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      interval: input.interval,
      intervalCount: input.intervalCount,
      includedCredit: input.includedCredit ?? {
        amountMinor: 0,
        currency: "USD",
      },
      includedTokens: input.includedTokens ?? 0,
      rateLimits: withIds,
      active: true,
    });
  });

export const updatePlan = (input: {
  readonly organizationId: HexId;
  readonly planId: HexId;
  readonly patch: Record<string, unknown>;
  readonly rateLimits?: readonly RateLimitRuleInput[] | undefined;
}): Effect.Effect<
  SubscriptionPlanDoc,
  PlanDomainError,
  PlanRepository | Crypto
> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    const crypto = yield* Crypto;
    const existing = yield* plans.findPlan(
      input.organizationId,
      input.planId,
    );
    if (!existing) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Plan not found",
          resource: "plan",
          id: input.planId,
        }),
      );
    }
    const $set: Record<string, unknown> = { ...input.patch };
    if (input.rateLimits !== undefined) {
      const withIds: RateLimitRule[] = [];
      for (const r of input.rateLimits) {
        const id =
          r.id ?? genRuleIdFromToken(yield* crypto.randomToken(6));
        withIds.push({
          id,
          windowSeconds: r.windowSeconds,
          dimension: r.dimension,
          capValue: r.capValue,
          scope: r.scope ?? "customer",
          scopeTarget: r.scopeTarget ?? null,
          currency: r.currency ?? null,
          active: r.active ?? true,
        });
      }
      $set.rateLimits = withIds;
    }
    const updated = yield* plans.updatePlan(
      input.organizationId,
      input.planId,
      $set,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Plan not found",
          resource: "plan",
          id: input.planId,
        }),
      );
    }
    return updated;
  });

export const deactivatePlan = (input: {
  readonly organizationId: HexId;
  readonly planId: HexId;
}): Effect.Effect<{ ok: true }, PlanDomainError, PlanRepository> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    const ok = yield* plans.deactivatePlan(
      input.organizationId,
      input.planId,
    );
    if (!ok) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Plan not found",
          resource: "plan",
          id: input.planId,
        }),
      );
    }
    return { ok: true as const };
  });

/**
 * Subscribe customer to an active plan. Centralized invariants:
 * customer exists, plan active, no concurrent active subscription.
 */
export const subscribeCustomer = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly planId: HexId;
}): Effect.Effect<
  SubscriptionDoc,
  PlanDomainError,
  PlanRepository | CustomerRepository | Clock
> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    const customers = yield* CustomerRepository;
    const clock = yield* Clock;

    const customer = yield* customers.findById(
      input.organizationId,
      input.customerId,
    );
    if (!customer) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Customer not found",
          resource: "customer",
          id: input.customerId,
        }),
      );
    }
    const plan = yield* plans.findPlan(input.organizationId, input.planId);
    if (!plan) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "plan_not_found",
          message: "Plan not found",
          resource: "plan",
          id: input.planId,
        }),
      );
    }
    if (!plan.active) {
      return yield* Effect.fail(
        new InvalidStateError({
          code: "plan_not_active",
          message: "Plan is not active",
          resource: "plan",
        }),
      );
    }
    const existing = yield* plans.findActiveSubscription(
      input.organizationId,
      input.customerId,
    );
    if (existing) {
      return yield* Effect.fail(
        new ConflictError({
          code: "subscription_already_active",
          message: "Customer already has an active subscription",
        }),
      );
    }

    const now = clock.now();
    const periodEnd = addInterval(now, plan.interval, plan.intervalCount);
    return yield* plans
      .insertSubscription({
        organizationId: input.organizationId,
        customerId: input.customerId,
        planId: input.planId,
        status: "active",
        periodStart: now,
        periodEnd,
      })
      .pipe(
        Effect.mapError((e) =>
          e._tag === "PersistenceDuplicateKeyError"
            ? new ConflictError({
                code: "subscription_already_active",
                message: "Customer already has an active subscription",
              })
            : e,
        ),
      );
  });

export const getActiveSubscription = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
}): Effect.Effect<
  { subscription: SubscriptionDoc; plan: SubscriptionPlanDoc | null },
  PlanDomainError,
  PlanRepository
> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    const subscription = yield* plans.findActiveSubscription(
      input.organizationId,
      input.customerId,
    );
    if (!subscription) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "No active subscription",
          resource: "subscription",
        }),
      );
    }
    const plan = yield* plans.findPlan(
      input.organizationId,
      subscription.planId.toHexString(),
    );
    return { subscription, plan };
  });

export const listCustomerLimits = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
}): Effect.Effect<readonly CustomerLimitDoc[], RepoError, PlanRepository> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    return yield* plans.listCustomerLimits(
      input.organizationId,
      input.customerId,
    );
  });

export const listCustomerBudgets = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
}): Effect.Effect<readonly BudgetDoc[], RepoError, PlanRepository> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    return yield* plans.listBudgets(input.organizationId, input.customerId);
  });
