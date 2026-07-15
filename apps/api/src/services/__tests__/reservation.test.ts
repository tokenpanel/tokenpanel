import { test, expect, describe } from "bun:test";
import {
  availableMinor,
  wouldReserveSucceed,
} from "../reservation.ts";
import { parseReservationCanaryOrgIds } from "../canary.ts";
import { ObjectId } from "mongodb";
import { parseApiRuntimeConfig } from "../../config/runtime.ts";

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

  test("wouldReserveSucceed: legacy amount would pass but available fails", () => {
    // amount 1000 >= need 100 (legacy ok) but reserved 950 → available 50.
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

describe("parseReservationCanaryOrgIds", () => {
  test("empty / unset → empty set", () => {
    expect(parseReservationCanaryOrgIds(undefined).size).toBe(0);
    expect(parseReservationCanaryOrgIds("").size).toBe(0);
    expect(parseReservationCanaryOrgIds("  ").size).toBe(0);
  });

  test("accepts valid ObjectIds, ignores junk", () => {
    const a = new ObjectId().toHexString();
    const b = new ObjectId().toHexString();
    const set = parseReservationCanaryOrgIds(`${a}, not-an-id, ${b.toUpperCase()}`);
    expect(set.has(a)).toBe(true);
    expect(set.has(b)).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe("parseApiRuntimeConfig reservation canary", () => {
  test("parses RESERVATION_CANARY_ORG_IDS into config set", () => {
    const id = new ObjectId().toHexString();
    const cfg = parseApiRuntimeConfig({
      JWT_SECRET: "dev-secret-not-for-production-use-xx",
      MONGODB_URI: "mongodb://localhost:27017",
      RESERVATION_CANARY_ORG_IDS: id,
    });
    expect(cfg.reservationCanaryOrgIds.has(id)).toBe(true);
  });

  test("defaults to empty canary set", () => {
    const cfg = parseApiRuntimeConfig({
      JWT_SECRET: "dev-secret-not-for-production-use-xx",
      MONGODB_URI: "mongodb://localhost:27017",
    });
    expect(cfg.reservationCanaryOrgIds.size).toBe(0);
  });
});
