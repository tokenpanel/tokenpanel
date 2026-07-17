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
  findDuplicateRateLimitStream,
  duplicateRateLimitStreamMessage,
} from "@tokenpanel/contracts";
import {
  ConflictError,
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from "../../errors/families.ts";
import type { HexId, RepoError } from "../ports/common.ts";
import { PlanRepository } from "../ports/plan-repository.ts";
import { CustomerRepository } from "../ports/customer-repository.ts";
import { OrganizationRepository } from "../ports/organization-repository.ts";
import { Clock } from "../../runtime/services/clock.ts";
import { Crypto } from "../../runtime/services/crypto.ts";
import { addInterval } from "./interval.ts";

export type PlanDomainError =
  | ConflictError
  | InvalidStateError
  | NotFoundError
  | ValidationError
  | RepoError;

/** Fail when two active rules would share the same rolling counter stream. */
function rejectDuplicateStreams(
  rules: readonly RateLimitRule[],
): Effect.Effect<void, ValidationError> {
  const dup = findDuplicateRateLimitStream(rules);
  if (!dup) return Effect.void;
  return Effect.fail(
    new ValidationError({
      code: "validation_error",
      message: duplicateRateLimitStreamMessage(dup),
      mode: "default_400",
      details: {
        rateLimits: [duplicateRateLimitStreamMessage(dup)],
      },
    }),
  );
}

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

/** Assign id + defaults so stored rules always match RateLimitRule. */
function ruleFromInput(r: RateLimitRuleInput, id: string): RateLimitRule {
  return {
    id,
    windowSeconds: r.windowSeconds,
    dimension: r.dimension,
    capValue: r.capValue,
    scope: r.scope ?? "customer",
    scopeTarget: r.scopeTarget ?? null,
    active: r.active ?? true,
  };
}

export const createPlan = (input: {
  readonly organizationId: HexId;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly price: { readonly amountUnits: number; readonly currency: string };
  readonly interval: string;
  readonly intervalCount: number;
  readonly includedCredit?:
    | { readonly amountUnits: number; readonly currency: string }
    | undefined;
  readonly includedTokens?: number | undefined;
  readonly rateLimits?: readonly RateLimitRuleInput[] | undefined;
}): Effect.Effect<
  SubscriptionPlanDoc,
  PlanDomainError,
  PlanRepository | Crypto | OrganizationRepository
> =>
  Effect.gen(function* () {
    const plans = yield* PlanRepository;
    const crypto = yield* Crypto;
    const orgs = yield* OrganizationRepository;
    const org = yield* orgs.findById(input.organizationId);
    const currency = org?.defaultCurrency ?? "USD";
    const withIds: RateLimitRule[] = [];
    for (const r of input.rateLimits ?? []) {
      const id =
        r.id ?? genRuleIdFromToken(yield* crypto.randomToken(6));
      withIds.push(ruleFromInput(r, id));
    }
    yield* rejectDuplicateStreams(withIds);
    return yield* plans.insertPlan({
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      price: {
        amountUnits: input.price.amountUnits,
        currency,
      },
      interval: input.interval,
      intervalCount: input.intervalCount,
      includedCredit: {
        amountUnits: input.includedCredit?.amountUnits ?? 0,
        currency,
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

    // Peel rateLimits out of the raw patch so we never persist optional-id inputs.
    // Stamp money currency to existing plan currency (org-owned; convert flow rewrites).
    const { rateLimits: patchRules, ...restPatch } = input.patch;
    const $set: Record<string, unknown> = { ...restPatch };
    if (
      $set.price !== undefined &&
      typeof $set.price === "object" &&
      $set.price !== null
    ) {
      const p = $set.price as { amountUnits?: number; currency?: string };
      $set.price = {
        amountUnits: p.amountUnits ?? existing.price.amountUnits,
        currency: existing.price.currency,
      };
    }
    if (
      $set.includedCredit !== undefined &&
      typeof $set.includedCredit === "object" &&
      $set.includedCredit !== null
    ) {
      const c = $set.includedCredit as {
        amountUnits?: number;
        currency?: string;
      };
      $set.includedCredit = {
        amountUnits: c.amountUnits ?? existing.includedCredit.amountUnits,
        currency: existing.includedCredit.currency,
      };
    }
    const rawRules = input.rateLimits ?? patchRules;
    if (rawRules !== undefined) {
      if (!Array.isArray(rawRules)) {
        return yield* Effect.fail(
          new InvalidStateError({
            code: "invalid_state",
            message: "rateLimits must be an array",
            resource: "plan",
          }),
        );
      }
      const withIds: RateLimitRule[] = [];
      for (const r of rawRules as RateLimitRuleInput[]) {
        const id =
          r.id ?? genRuleIdFromToken(yield* crypto.randomToken(6));
        withIds.push(ruleFromInput(r, id));
      }
      yield* rejectDuplicateStreams(withIds);
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
