/**
 * Browser-safe money / currency product contracts.
 *
 * Policy version: 2026-07-15
 * Money is always integer units + ISO 4217 currency — never floats.
 * Migrations MUST NOT import this module — keep frozen snapshots.
 *
 * Effect Schema live under `@tokenpanel/contracts/effect`.
 *
 * amountUnits scale is ISO 4217 exponent for the currency code:
 * 1 unit = 10^(-exp) of the major unit (USD: $0.01, JPY: ¥1, KWD: 0.001 KWD).
 */
import {
  CurrencyCode,
  MoneyUnits,
  Money,
} from "./effect/primitives.ts";
import { withParseApi } from "./parse.ts";

/** Tokens priced per this many units (standard LLM pricing denominator). */
export const TOKENS_PER_MILLION_COUNT = 1_000_000;

export type { CurrencyCode, MoneyUnits, Money };

export const currencyCodeSchema = withParseApi(CurrencyCode);
export const moneyUnitsSchema = withParseApi(MoneyUnits);
export const moneySchema = withParseApi(Money);
