/**
 * Effect Schema leaf contracts for money/currency (browser-safe).
 */
import type { Schema } from "effect";
import {
  CurrencyCode,
  MoneyUnits,
  Money,
} from "./primitives.ts";

export {
  CurrencyCode,
  MoneyUnits,
  Money,
  CurrencyCode as currencyCodeSchema,
  MoneyUnits as moneyUnitsSchema,
  Money as moneySchema,
};

export type CurrencyCodeType = Schema.Schema.Type<typeof CurrencyCode>;
export type MoneyUnitsType = Schema.Schema.Type<typeof MoneyUnits>;
export type MoneyType = Schema.Schema.Type<typeof Money>;
