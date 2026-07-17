/**
 * Browser-safe money / currency product contracts.
 *
 * Policy version: 2026-07-15
 * Money is always integer minor units + ISO 4217 currency — never floats.
 * Migrations MUST NOT import this module — keep frozen snapshots.
 *
 * Effect Schema live under `@tokenpanel/contracts/effect`.
 */
import {
  CurrencyCode,
  MoneyMinor,
  Money,
} from "./effect/primitives.ts";
import { withParseApi } from "./parse.ts";

/** Tokens priced per this many units (standard LLM pricing denominator). */
export const TOKENS_PER_MILLION_COUNT = 1_000_000;

export type { CurrencyCode, MoneyMinor, Money };

export const currencyCodeSchema = withParseApi(CurrencyCode);
export const moneyMinorSchema = withParseApi(MoneyMinor);
export const moneySchema = withParseApi(Money);
