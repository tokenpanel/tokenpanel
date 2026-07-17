import { test, expect } from "bun:test";
import { normalizeLegacyMoneyFields } from "../legacy-money-normalize.ts";

test("promotes balance amountMinor/reservedMinor → Units", () => {
  const out = normalizeLegacyMoneyFields({
    balance: { amountMinor: 1000, reservedMinor: 50, currency: "USD" },
  }) as {
    balance: {
      amountUnits: number;
      reservedUnits: number;
      currency: string;
      amountMinor?: number;
    };
  };
  expect(out.balance.amountUnits).toBe(1000);
  expect(out.balance.reservedUnits).toBe(50);
  expect(out.balance.amountMinor).toBeUndefined();
  expect(out.balance.currency).toBe("USD");
});

test("non-balance fields prefer existing Units over Minor", () => {
  const out = normalizeLegacyMoneyFields({
    amountUnits: 5,
    amountMinor: 9,
  }) as { amountUnits: number; amountMinor?: number };
  expect(out.amountUnits).toBe(5);
  expect(out.amountMinor).toBeUndefined();
});

test("balance prefers Minor when both present (old-writer truth)", () => {
  const out = normalizeLegacyMoneyFields({
    balance: {
      amountUnits: 1000,
      amountMinor: 900,
      reservedUnits: 10,
      reservedMinor: 5,
      currency: "USD",
    },
  }) as {
    balance: { amountUnits: number; reservedUnits: number };
  };
  expect(out.balance.amountUnits).toBe(900);
  expect(out.balance.reservedUnits).toBe(5);
});

test("promotes model entry schedule leaves", () => {
  const out = normalizeLegacyMoneyFields({
    entries: [
      {
        id: "e1",
        price: { inputMinorPerMillion: 100, outputMinorPerMillion: 200 },
        cost: { inputMinorPerMillion: 50, outputUnitsPerMillion: 80 },
      },
    ],
  }) as {
    entries: Array<{
      price: Record<string, number>;
      cost: Record<string, number>;
    }>;
  };
  expect(out.entries[0]!.price.inputUnitsPerMillion).toBe(100);
  expect(out.entries[0]!.price.outputUnitsPerMillion).toBe(200);
  expect(out.entries[0]!.cost.inputUnitsPerMillion).toBe(50);
  expect(out.entries[0]!.cost.outputUnitsPerMillion).toBe(80);
  expect(out.entries[0]!.price.inputMinorPerMillion).toBeUndefined();
});

test("maps spend_minor dimension → spend_units on rules", () => {
  const out = normalizeLegacyMoneyFields({
    rateLimits: [{ id: "r1", dimension: "spend_minor", capValue: 1 }],
    rules: [{ id: "r2", dimension: "spend_minor", capValue: 2 }],
    dimension: "spend_minor",
  }) as {
    rateLimits: Array<{ dimension: string }>;
    rules: Array<{ dimension: string }>;
    dimension: string;
  };
  expect(out.rateLimits[0]!.dimension).toBe("spend_units");
  expect(out.rules[0]!.dimension).toBe("spend_units");
  expect(out.dimension).toBe("spend_units");
});

test("promotes outbox context money keys + schedules", () => {
  const out = normalizeLegacyMoneyFields({
    context: {
      priceMinor: 10,
      reservedMinor: 3,
      priceSchedule: { inputMinorPerMillion: 1, outputMinorPerMillion: 2 },
    },
  }) as {
    context: {
      priceUnits: number;
      reservedUnits: number;
      priceSchedule: Record<string, number>;
    };
  };
  expect(out.context.priceUnits).toBe(10);
  expect(out.context.reservedUnits).toBe(3);
  expect(out.context.priceSchedule.inputUnitsPerMillion).toBe(1);
});
