/**
 * @tokenpanel/contracts — browser-safe shared product contracts.
 *
 * Rules:
 * - Pure TypeScript / Zod only.
 * - No environment reads, I/O, Node/Bun builtins, Mongo, Hono, or UI imports.
 * - Immutable exports; no mutable Set/Map published as public API surface
 *   (internal lookup sets are private).
 * - Migrations must not import this package.
 */

export {
  MODEL_MODALITIES,
  modelModalitySchema,
  modelModalitiesSchema,
  MODEL_STATUSES,
  modelStatusSchema,
  MODEL_METADATA_POLICY,
  MODEL_METADATA_RESERVED_KEYS,
  isValidModelMetadataKey,
  isReservedModelMetadataKey,
  normalizeMetadataValueNewlines,
} from "./model.ts";
export type {
  ModelModality,
  ModelModalities,
  ModelStatus,
  ModelMetadataPolicy,
  ModelMetadataReservedKey,
} from "./model.ts";

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
  currencyCodeSchema,
  moneyMinorSchema,
  moneySchema,
} from "./common.ts";
export type { CurrencyCode, Money } from "./common.ts";
