/**
 * Repository ports for domain operations.
 * Live adapters: infrastructure/mongo/repositories/live.ts (Effect Schema decode).
 * §7 ObjectId repos: infrastructure/mongo/repositories/{organizations,identity,…}.ts
 */

export type {
  HexId,
  RepoError,
  RepoEffect,
  PageQuery,
  PageResult,
  DateRange,
} from "./common.ts";

export {
  UserRepository,
  type UserRepositoryService,
  type NewUserRecord,
} from "./user-repository.ts";

export {
  InviteRepository,
  type InviteRepositoryService,
  type NewInviteRecord,
} from "./invite-repository.ts";

export {
  OrganizationRepository,
  type OrganizationRepositoryService,
  type NewOrganizationRecord,
  type OrganizationCounts,
} from "./organization-repository.ts";

export {
  CustomerRepository,
  type CustomerRepositoryService,
  type CustomerListFilter,
  type NewCustomerRecord,
  type BalanceAdjustInput,
} from "./customer-repository.ts";

export {
  PlanRepository,
  type PlanRepositoryService,
  type NewPlanRecord,
  type NewSubscriptionRecord,
} from "./plan-repository.ts";

export {
  ModelRepository,
  type ModelRepositoryService,
  type NewModelRecord,
} from "./model-repository.ts";

export {
  ProviderRepository,
  type ProviderRepositoryService,
  type NewProviderRecord,
} from "./provider-repository.ts";

export {
  KeyRepository,
  type KeyRepositoryService,
  type NewCustomerKeyRecord,
  type NewManagementKeyRecord,
} from "./key-repository.ts";

export {
  UsageRepository,
  type UsageRepositoryService,
  type CustomerUsageSummary,
  type AnalyticsCurrencyTotals,
  type AnalyticsTopCustomer,
  type DashboardSummary,
  type UsageByModelRow,
} from "./usage-repository.ts";
