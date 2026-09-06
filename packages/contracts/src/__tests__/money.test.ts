import { test, expect, describe } from "bun:test";
import {
  TOKENS_PER_MILLION_COUNT,
  currencyCodeSchema,
  moneyUnitsSchema,
  moneySchema,
} from "../money.ts";

test("TOKENS_PER_MILLION_COUNT is the standard LLM pricing denominator", () => {
  expect(TOKENS_PER_MILLION_COUNT).toBe(1_000_000);
  expect(Number.isSafeInteger(TOKENS_PER_MILLION_COUNT)).toBe(true);
  expect(TOKENS_PER_MILLION_COUNT).toBeGreaterThan(0);
});

describe("currencyCodeSchema (ISO 4217: 3 uppercase letters)", () => {
  test("accepts valid codes, identity on accept", () => {
    for (const code of ["USD", "EUR", "JPY", "KWD", "BHD"]) {
      const r = currencyCodeSchema.safeParse(code);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(code);
    }
  });

  test("rejects wrong casing", () => {
    for (const bad of ["usd", "Usd", "uSD", "usD"]) {
      expect(currencyCodeSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("rejects wrong length", () => {
    expect(currencyCodeSchema.safeParse("US").success).toBe(false);
    expect(currencyCodeSchema.safeParse("USDX").success).toBe(false);
    expect(currencyCodeSchema.safeParse("").success).toBe(false);
  });

  test("rejects non-letter and non-string inputs", () => {
    expect(currencyCodeSchema.safeParse("US1").success).toBe(false);
    expect(currencyCodeSchema.safeParse("U-D").success).toBe(false);
    expect(currencyCodeSchema.safeParse(42).success).toBe(false);
    expect(currencyCodeSchema.safeParse(null).success).toBe(false);
    expect(currencyCodeSchema.safeParse(undefined).success).toBe(false);
    expect(currencyCodeSchema.safeParse(["USD"]).success).toBe(false);
  });
});

describe("moneyUnitsSchema (non-negative integer currency units)", () => {
  test("accepts zero and positive safe integers", () => {
    expect(moneyUnitsSchema.safeParse(0).success).toBe(true);
    expect(moneyUnitsSchema.safeParse(15).success).toBe(true);
    expect(moneyUnitsSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(
      true,
    );
  });

  test("rejects negatives, fractions, and non-numbers", () => {
    expect(moneyUnitsSchema.safeParse(-1).success).toBe(false);
    expect(moneyUnitsSchema.safeParse(0.5).success).toBe(false);
    expect(moneyUnitsSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(
      false,
    );
    expect(moneyUnitsSchema.safeParse("15").success).toBe(false);
    expect(moneyUnitsSchema.safeParse(null).success).toBe(false);
  });
});

describe("moneySchema shape", () => {
  test("decodes minimal Money (amountMicros + currency)", () => {
    const r = moneySchema.safeParse({ amountMicros: 150_000, currency: "USD" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ amountMicros: 150_000, currency: "USD" });
    }
  });

  test("decodes full Money with optional amountUnits", () => {
    const r = moneySchema.safeParse({
      amountMicros: 150_000,
      currency: "EUR",
      amountUnits: 15,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({
        amountMicros: 150_000,
        currency: "EUR",
        amountUnits: 15,
      });
    }
  });

  test("rejects missing or invalid currency", () => {
    expect(
      moneySchema.safeParse({ amountMicros: 150_000 }).success,
    ).toBe(false);
    expect(
      moneySchema.safeParse({ amountMicros: 150_000, currency: "usd" }).success,
    ).toBe(false);
  });

  test("rejects invalid amountMicros", () => {
    expect(moneySchema.safeParse({ currency: "USD" }).success).toBe(false);
    expect(
      moneySchema.safeParse({ amountMicros: -1, currency: "USD" }).success,
    ).toBe(false);
    expect(
      moneySchema.safeParse({ amountMicros: 1.5, currency: "USD" }).success,
  ).toBe(false);
  });

  test("rejects invalid optional amountUnits", () => {
    expect(
      moneySchema.safeParse({
        amountMicros: 150_000,
        currency: "USD",
        amountUnits: -1,
      }).success,
    ).toBe(false);
    expect(
      moneySchema.safeParse({
        amountMicros: 150_000,
        currency: "USD",
        amountUnits: 0.5,
      }).success,
    ).toBe(false);
  });

  test("rejects non-object inputs", () => {
    expect(moneySchema.safeParse(null).success).toBe(false);
    expect(moneySchema.safeParse(42).success).toBe(false);
    expect(moneySchema.safeParse("150000 USD").success).toBe(false);
  });
});
