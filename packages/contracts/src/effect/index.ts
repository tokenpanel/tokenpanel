/**
 * @tokenpanel/contracts/effect — browser-safe Effect Schema product contracts.
 *
 * Canonical Effect Schema product contracts.
 * Rules:
 * - Pure TypeScript / Effect Schema only (Requirements = never).
 * - No environment, I/O, Node/Bun, Mongo, Hono, or UI imports.
 * - Migrations must not import this package.
 */

export * from "./primitives.ts";
// common.ts aliases only (values already exported from primitives)
export {
  currencyCodeSchema,
  moneyUnitsSchema,
  moneySchema,
} from "./common.ts";
export * from "./safe-map.ts";
export * from "./model.ts";
export * from "./management-scopes.ts";
export * from "./panel-permissions.ts";
