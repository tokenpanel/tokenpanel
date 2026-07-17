import { test, expect, describe } from "bun:test";
import {
  availableMinor,
  wouldReserveSucceed,
} from "../reservation.ts";

describe("availableMinor / wouldReserveSucceed", () => {
  test("available = amount - reserved", () => {
    expect(availableMinor({ amountMinor: 1000, reservedMinor: 200 })).toBe(800);
    expect(availableMinor({ amountMinor: 100, reservedMinor: 0 })).toBe(100);
    expect(availableMinor({ amountMinor: 50 })).toBe(50);
    // Never negative available.
    expect(availableMinor({ amountMinor: 10, reservedMinor: 50 })).toBe(0);
  });

  test("wouldReserveSucceed: currency mismatch", () => {
    const r = wouldReserveSucceed(
      { amountMinor: 1000, reservedMinor: 0, currency: "USD" },
      100,
      "EUR",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("currency_mismatch");
  });

  test("wouldReserveSucceed: insufficient available (held reduces capacity)", () => {
    const r = wouldReserveSucceed(
      { amountMinor: 1000, reservedMinor: 900, currency: "USD" },
      200,
      "USD",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insufficient_available");
  });

  test("wouldReserveSucceed: amount would pass but available fails", () => {
    // amount 1000 >= need 100 but reserved 950 → available 50.
    const snap = { amountMinor: 1000, reservedMinor: 950, currency: "USD" };
    expect(snap.amountMinor >= 100).toBe(true);
    expect(wouldReserveSucceed(snap, 100, "USD").ok).toBe(false);
  });

  test("wouldReserveSucceed: zero need always ok", () => {
    expect(
      wouldReserveSucceed(
        { amountMinor: 0, reservedMinor: 0, currency: "USD" },
        0,
        "USD",
      ).ok,
    ).toBe(true);
  });

  test("wouldReserveSucceed: sufficient available", () => {
    expect(
      wouldReserveSucceed(
        { amountMinor: 1000, reservedMinor: 100, currency: "USD" },
        500,
        "USD",
      ).ok,
    ).toBe(true);
  });
});
