import { test, expect, describe } from "bun:test";
import {
  rateLimitStreamDimension,
  rateLimitStreamKey,
  findDuplicateRateLimitStream,
} from "../rate-limits.ts";

describe("rateLimitStreamDimension: units → micros equivalence", () => {
  test("spend_units normalizes to spend_micros", () => {
    expect(rateLimitStreamDimension("spend_units")).toBe("spend_micros");
  });

  test("other dimensions pass through untouched", () => {
    expect(rateLimitStreamDimension("spend_micros")).toBe("spend_micros");
    expect(rateLimitStreamDimension("tokens")).toBe("tokens");
    expect(rateLimitStreamDimension("requests")).toBe("requests");
  });

  test("identical semantic spend limit → same stream key in either unit", () => {
    // A $10/hour customer-global cap expressed in legacy units (10,000,000
    // units) or in micros (10,000,000,000 micros) is one and the same stream.
    const unitsRule = {
      windowSeconds: 3600,
      dimension: "spend_units",
      scope: "customer",
    };
    const microsRule = {
      windowSeconds: 3600,
      dimension: "spend_micros",
      scope: "customer",
      capValue: 10_000_000_000,
    };
    expect(rateLimitStreamKey(unitsRule)).toBe(rateLimitStreamKey(microsRule));
    expect(rateLimitStreamKey(unitsRule)).toBe(
      rateLimitStreamKey({ ...unitsRule, dimension: "spend_micros" }),
    );
  });

  test("spend rules collide on stream identity regardless of unit label", () => {
    const dup = findDuplicateRateLimitStream([
      { windowSeconds: 3600, dimension: "spend_units", scope: "customer" },
      { windowSeconds: 3600, dimension: "spend_micros", scope: "customer" },
    ]);
    expect(dup).not.toBeNull();
    expect(dup?.firstIndex).toBe(0);
    expect(dup?.secondIndex).toBe(1);
    expect(dup?.streamKey).toBe(rateLimitStreamKey({
      windowSeconds: 3600,
      dimension: "spend_micros",
      scope: "customer",
    }));
  });

  test("model-scoped spend targets still collide across unit labels", () => {
    const dup = findDuplicateRateLimitStream([
      {
        windowSeconds: 60,
        dimension: "spend_units",
        scope: "model",
        scopeTarget: "gpt-x",
      },
      {
        windowSeconds: 60,
        dimension: "spend_micros",
        scope: "model",
        scopeTarget: "gpt-x",
      },
    ]);
    expect(dup).not.toBeNull();
    expect(dup?.dimension).toBe("spend_micros");
  });
});
