import { test, expect } from "bun:test";
import {
  rateLimitStreamKey,
  rateLimitStreamScope,
  findDuplicateRateLimitStream,
  duplicateRateLimitStreamMessage,
} from "../rate-limits.ts";

test("rateLimitStreamScope: plan/customer/null → customer; model kept", () => {
  expect(rateLimitStreamScope("customer")).toBe("customer");
  expect(rateLimitStreamScope("plan")).toBe("customer");
  expect(rateLimitStreamScope(null)).toBe("customer");
  expect(rateLimitStreamScope(undefined)).toBe("customer");
  expect(rateLimitStreamScope("model")).toBe("model");
  expect(rateLimitStreamScope("endpoint")).toBe("customer");
});

test("rateLimitStreamKey: same dim+window+global scope collide", () => {
  const a = rateLimitStreamKey({
    dimension: "tokens",
    windowSeconds: 3600,
    scope: "customer",
  });
  const b = rateLimitStreamKey({
    dimension: "tokens",
    windowSeconds: 3600,
    scope: "plan",
  });
  expect(a).toBe(b);
});

test("rateLimitStreamKey: different windows or dimensions are distinct", () => {
  const hour = rateLimitStreamKey({
    dimension: "tokens",
    windowSeconds: 3600,
    scope: "customer",
  });
  const week = rateLimitStreamKey({
    dimension: "tokens",
    windowSeconds: 604_800,
    scope: "customer",
  });
  const reqs = rateLimitStreamKey({
    dimension: "requests",
    windowSeconds: 3600,
    scope: "customer",
  });
  expect(hour).not.toBe(week);
  expect(hour).not.toBe(reqs);
});

test("rateLimitStreamKey: model targets differ; spend has no currency axis", () => {
  const m1 = rateLimitStreamKey({
    dimension: "tokens",
    windowSeconds: 3600,
    scope: "model",
    scopeTarget: "gpt",
  });
  const m2 = rateLimitStreamKey({
    dimension: "tokens",
    windowSeconds: 3600,
    scope: "model",
    scopeTarget: "claude",
  });
  expect(m1).not.toBe(m2);

  // Org is single-currency: spend streams ignore any legacy currency field.
  const spendA = rateLimitStreamKey({
    dimension: "spend_units",
    windowSeconds: 3600,
    scope: "customer",
  });
  const spendB = rateLimitStreamKey({
    dimension: "spend_units",
    windowSeconds: 3600,
    scope: "customer",
  });
  expect(spendA).toBe(spendB);
});

test("findDuplicateRateLimitStream: hour+week ok; two hours fail", () => {
  expect(
    findDuplicateRateLimitStream([
      { dimension: "tokens", windowSeconds: 3600, scope: "customer" },
      { dimension: "tokens", windowSeconds: 604_800, scope: "customer" },
    ]),
  ).toBeNull();

  const dup = findDuplicateRateLimitStream([
    { dimension: "tokens", windowSeconds: 3600, scope: "customer" },
    { dimension: "tokens", windowSeconds: 3600, scope: "customer" },
  ]);
  expect(dup).not.toBeNull();
  expect(dup?.firstIndex).toBe(0);
  expect(dup?.secondIndex).toBe(1);
  expect(duplicateRateLimitStreamMessage(dup!)).toContain("Duplicate rate limit stream");
});

test("findDuplicateRateLimitStream: inactive does not count", () => {
  expect(
    findDuplicateRateLimitStream([
      {
        dimension: "tokens",
        windowSeconds: 3600,
        scope: "customer",
        active: true,
      },
      {
        dimension: "tokens",
        windowSeconds: 3600,
        scope: "customer",
        active: false,
      },
    ]),
  ).toBeNull();
});
