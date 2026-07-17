/**
 * Plan / subscription / limit / budget persistence port (section 8 temporary).
 */
import { Context, type Effect } from "effect";
import type {
  SubscriptionPlanDoc,
  SubscriptionDoc,
  RateLimitRule,
  CustomerLimitDoc,
  BudgetDoc,
} from "@tokenpanel/db";
import type { HexId, RepoError } from "./common.ts";

export type NewPlanRecord = {
  readonly organizationId: HexId;
  readonly name: string;
  readonly description: string | null;
  readonly price: { readonly amountUnits: number; readonly currency: string };
  readonly interval: string;
  readonly intervalCount: number;
  readonly includedCredit: {
    readonly amountUnits: number;
    readonly currency: string;
  };
  readonly includedTokens: number;
  readonly rateLimits: readonly RateLimitRule[];
  readonly active: boolean;
};

export type NewSubscriptionRecord = {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly planId: HexId;
  readonly status: "active";
  readonly periodStart: Date;
  readonly periodEnd: Date;
};

export type PlanRepositoryService = {
  readonly listPlans: (
    organizationId: HexId,
  ) => Effect.Effect<readonly SubscriptionPlanDoc[], RepoError>;
  readonly findPlan: (
    organizationId: HexId,
    planId: HexId,
  ) => Effect.Effect<SubscriptionPlanDoc | null, RepoError>;
  readonly insertPlan: (
    record: NewPlanRecord,
  ) => Effect.Effect<SubscriptionPlanDoc, RepoError>;
  readonly updatePlan: (
    organizationId: HexId,
    planId: HexId,
    patch: Record<string, unknown>,
  ) => Effect.Effect<SubscriptionPlanDoc | null, RepoError>;
  readonly deactivatePlan: (
    organizationId: HexId,
    planId: HexId,
  ) => Effect.Effect<boolean, RepoError>;
  readonly findActiveSubscription: (
    organizationId: HexId,
    customerId: HexId,
  ) => Effect.Effect<SubscriptionDoc | null, RepoError>;
  readonly insertSubscription: (
    record: NewSubscriptionRecord,
  ) => Effect.Effect<SubscriptionDoc, RepoError>;
  readonly listCustomerLimits: (
    organizationId: HexId,
    customerId: HexId,
  ) => Effect.Effect<readonly CustomerLimitDoc[], RepoError>;
  readonly listBudgets: (
    organizationId: HexId,
    customerId: HexId,
  ) => Effect.Effect<readonly BudgetDoc[], RepoError>;
};

export class PlanRepository extends Context.Tag("tokenpanel/PlanRepository")<
  PlanRepository,
  PlanRepositoryService
>() {}
