/**
 * Domain-facing persistence document shapes (task 13.3).
 *
 * Domains may `import type` these aliases (or the underlying `@tokenpanel/db`
 * schemas) but must never value-import Mongo drivers, `getDb`, or collection
 * strings. Infrastructure repositories map BSON ↔ these types at the boundary.
 */
export type {
  UserDoc,
  UserRole,
  MembershipDoc,
  InviteDoc,
  OrganizationDoc,
  CustomerDoc,
  BalanceAdjustmentDoc,
  ProviderDoc,
  ModelDoc,
  ModelEntryDoc,
  ModelCatalogDoc,
  ApiKeyDoc,
  ManagementApiKeyDoc,
  ManagementScope,
  SubscriptionPlanDoc,
  SubscriptionDoc,
  CustomerLimitDoc,
  BudgetDoc,
  RateLimitRule,
  SettlementOutboxDoc,
  UsageRecordDoc,
  TypedDb,
} from "@tokenpanel/db";
