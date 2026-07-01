import { type Collection } from "mongodb";
import type {
  OrganizationDoc,
  OrganizationCreateInput,
  OrganizationApiCreateInput,
  OrganizationApiUpdateInput,
} from "../schemas/organization.ts";
import type {
  UserDoc,
  UserCreateInput,
  UserUpdateInput,
  MembershipDoc,
  MembershipInput,
  InviteDoc,
  InviteCreateInput,
} from "../schemas/user.ts";
import type {
  CustomerDoc,
  CustomerCreateInput,
  CustomerUpdateInput,
  BalanceAdjustmentDoc,
  BalanceAdjustmentCreateInput,
} from "../schemas/customer.ts";
import type {
  ProviderDoc,
  ProviderCreateInput,
  ProviderUpdateInput,
  ModelCatalogDoc,
  ModelDoc,
  ModelCreateInput,
  ModelUpdateInput,
  FallbackReorderInput,
} from "../schemas/model.ts";
import type {
  SubscriptionPlanDoc,
  SubscriptionPlanCreateInput,
  SubscriptionPlanUpdateInput,
  SubscriptionDoc,
  SubscriptionCreateInput,
  CustomerLimitDoc,
  CustomerLimitCreateInput,
  CustomerLimitUpdateInput,
  BudgetDoc,
  BudgetCreateInput,
  RateLimitRule,
  RateLimitRuleInput,
  LimitDimension,
  LimitScope,
} from "../schemas/limit.ts";
import type {
  UsageRecordDoc,
  UsageRecordCreateInput,
  RateLimitCounterDoc,
  RateLimitCounterCreateInput,
} from "../schemas/usage.ts";
import type {
  ApiKeyDoc,
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
} from "../schemas/apikey.ts";

/**
 * Central registry of collection names and typed accessors.
 * Use these instead of `db.collection("...")` literals elsewhere.
 */
export const collections = {
  organizations: "organizations",
  users: "users",
  invites: "invites",
  customers: "customers",
  balanceAdjustments: "balance_adjustments",
  providers: "providers",
  modelCatalog: "model_catalog",
  models: "models",
  subscriptionPlans: "subscription_plans",
  subscriptions: "subscriptions",
  customerLimits: "customer_limits",
  budgets: "budgets",
  usageRecords: "usage_records",
  rateLimitCounters: "rate_limit_counters",
  apiKeys: "api_keys",
} as const;

export type Collections = typeof collections;

/** Typed wrapper around a Mongo Db exposing our collection names. */
export interface TypedDb {
  organizations: Collection<OrganizationDoc>;
  users: Collection<UserDoc>;
  invites: Collection<InviteDoc>;
  customers: Collection<CustomerDoc>;
  balanceAdjustments: Collection<BalanceAdjustmentDoc>;
  providers: Collection<ProviderDoc>;
  modelCatalog: Collection<ModelCatalogDoc>;
  models: Collection<ModelDoc>;
  subscriptionPlans: Collection<SubscriptionPlanDoc>;
  subscriptions: Collection<SubscriptionDoc>;
  customerLimits: Collection<CustomerLimitDoc>;
  budgets: Collection<BudgetDoc>;
  usageRecords: Collection<UsageRecordDoc>;
  rateLimitCounters: Collection<RateLimitCounterDoc>;
  apiKeys: Collection<ApiKeyDoc>;
}

export type CollectionInsert<T> = Omit<T, "_id" | "createdAt" | "updatedAt">;

export type {
  OrganizationDoc,
  OrganizationCreateInput,
  OrganizationApiCreateInput,
  OrganizationApiUpdateInput,
  UserDoc,
  UserCreateInput,
  UserUpdateInput,
  MembershipDoc,
  MembershipInput,
  InviteDoc,
  InviteCreateInput,
  CustomerDoc,
  CustomerCreateInput,
  CustomerUpdateInput,
  BalanceAdjustmentDoc,
  BalanceAdjustmentCreateInput,
  ProviderDoc,
  ProviderCreateInput,
  ProviderUpdateInput,
  ModelCatalogDoc,
  ModelDoc,
  ModelCreateInput,
  ModelUpdateInput,
  FallbackReorderInput,
  SubscriptionPlanDoc,
  SubscriptionPlanCreateInput,
  SubscriptionPlanUpdateInput,
  SubscriptionDoc,
  SubscriptionCreateInput,
  CustomerLimitDoc,
  CustomerLimitCreateInput,
  CustomerLimitUpdateInput,
  BudgetDoc,
  BudgetCreateInput,
  RateLimitRule,
  RateLimitRuleInput,
  LimitDimension,
  LimitScope,
  UsageRecordDoc,
  UsageRecordCreateInput,
  RateLimitCounterDoc,
  RateLimitCounterCreateInput,
  ApiKeyDoc,
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
};