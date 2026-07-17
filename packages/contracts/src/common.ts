/**
 * Shared leaf validation schemas used by more than one runtime.
 * Prefer leaf schemas over one giant FIELD_LIMITS object.
 *
 * Money/currency authority lives in `./money.ts` (re-exported here for
 * historical import paths).
 */

export {
  TOKENS_PER_MILLION_COUNT,
  currencyCodeSchema,
  moneyUnitsSchema,
  moneySchema,
} from "./money.ts";
export type { CurrencyCode, Money } from "./money.ts";
