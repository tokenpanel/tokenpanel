import { test, expect, describe } from "bun:test";
import {
  availableUnits,
  wouldReserveSucceed,
} from "../reservation.ts";

describe("availableUnits / wouldReserveSucceed", () => {
  test("available = amount - reserved", () => {
    expect(availableUnits({ amountUnits: 1000, reservedUnits: 200 })).toBe(800);
    expect(availableUnits({ amountUnits: 100, reservedUnits: 0 })).toBe(100);
    expect(availableUnits({ amountUnits: 50 })).toBe(50);
    // Never negative available.
    expect(availableUnits({ amountUnits: 10, reservedUnits: 50 })).toBe(0);
  });

  test("wouldReserveSucceed: currency mismatch", () => {
    const r = wouldReserveSucceed(
      { amountUnits: 1000, reservedUnits: 0, currency: "USD" },
      100,
      "EUR",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("currency_mismatch");
  });

  test("wouldReserveSucceed: insufficient available (held reduces capacity)", () => {
    const r = wouldReserveSucceed(
      { amountUnits: 1000, reservedUnits: 900, currency: "USD" },
      200,
      "USD",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insufficient_available");
  });

  test("wouldReserveSucceed: amount would pass but available fails", () => {
    // amount 1000 >= need 100 but reserved 950 → available 50.
    const snap = { amountUnits: 1000, reservedUnits: 950, currency: "USD" };
    expect(snap.amountUnits >= 100).toBe(true);
    expect(wouldReserveSucceed(snap, 100, "USD").ok).toBe(false);
  });

  test("wouldReserveSucceed: zero need always ok", () => {
    expect(
      wouldReserveSucceed(
        { amountUnits: 0, reservedUnits: 0, currency: "USD" },
        0,
        "USD",
      ).ok,
    ).toBe(true);
  });

  test("wouldReserveSucceed: sufficient available", () => {
    expect(
      wouldReserveSucceed(
        { amountUnits: 1000, reservedUnits: 100, currency: "USD" },
        500,
        "USD",
      ).ok,
    ).toBe(true);
  });
});
