/**
 * @tokenpanel/contracts — browser-safe shared product contracts.
 *
 * Rules:
 * - Pure TypeScript + Effect Schema only.
 * - No environment reads, I/O, Node/Bun builtins, Mongo, Hono, or UI imports.
 * - Immutable exports; no mutable Set/Map published as public API surface
 *   (internal lookup sets are private).
 * - Migrations must not import this package.
 *
 * Effect Schema entry: `@tokenpanel/contracts/effect` (or `./effect`).
 */

export {
  MODEL_MODALITIES,
  MODEL_STATUSES,
  MODEL_METADATA_POLICY,
  MODEL_METADATA_RESERVED_KEYS,
  isValidModelMetadataKey,
  isReservedModelMetadataKey,
  normalizeMetadataValueNewlines,
  SAFE_MAP_RESERVED_KEYS,
  PROVIDER_HEADERS_POLICY,
  CALLER_METADATA_POLICY,
  isValidSafeMapKey,
  isReservedSafeMapKey,
  isSafeJsonMapValue,
  isPlainObject,
  SAFE_JSON_MAP_MAX_DEPTH,
  SAFE_JSON_MAP_VALUE_MAX_CHARS,
} from "./model.ts";
export type {
  ModelModality,
  ModelModalities,
  ModelStatus,
  ModelMetadataPolicy,
  ModelMetadataReservedKey,
  SafeMapPolicy,
  SafeMapReservedKey,
  ProviderHeadersPolicy,
  CallerMetadataPolicy,
} from "./model.ts";
// Effect Schema product enums (live under effect/ to avoid circular init)
export {
  modelModalitySchema,
  modelModalitiesSchema,
  modelStatusSchema,
} from "./model-schemas.ts";

export {
  MANAGEMENT_SCOPE_DEFINITIONS,
  MANAGEMENT_SCOPES,
  MANAGEMENT_SCOPES_META,
  managementScopeSchema,
} from "./management-scopes.ts";
export type {
  ManagementScope,
  ManagementScopeDefinition,
  ManagementScopeMeta,
} from "./management-scopes.ts";

export {
  TOKENS_PER_MILLION_COUNT,
  currencyCodeSchema,
  moneyMinorSchema,
  moneySchema,
} from "./money.ts";
export type { CurrencyCode, Money, MoneyMinor } from "./money.ts";

export {
  CUSTOMER_STATUSES,
  customerStatusSchema,
  BALANCE_ADJUSTMENT_REASONS,
  balanceAdjustmentReasonSchema,
  OPERATOR_BALANCE_REASONS,
} from "./customer.ts";
export type {
  CustomerStatus,
  BalanceAdjustmentReason,
  OperatorBalanceReason,
} from "./customer.ts";

export {
  PLAN_INTERVALS,
  planIntervalSchema,
  SUBSCRIPTION_STATUSES,
  subscriptionStatusSchema,
} from "./plan.ts";
export type { PlanInterval, SubscriptionStatus } from "./plan.ts";
