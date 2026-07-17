/**
 * Effect Schema leaf contracts for money/currency (browser-safe).
 */
import type { Schema } from "effect";
import {
  CurrencyCode,
  MoneyMinor,
  Money,
} from "./primitives.ts";

export {
  CurrencyCode,
  MoneyMinor,
  Money,
  CurrencyCode as currencyCodeSchema,
  MoneyMinor as moneyMinorSchema,
  Money as moneySchema,
};

export type CurrencyCodeType = Schema.Schema.Type<typeof CurrencyCode>;
export type MoneyMinorType = Schema.Schema.Type<typeof MoneyMinor>;
export type MoneyType = Schema.Schema.Type<typeof Money>;
