import { test, expect } from "bun:test";
import { genRuleId, normalizeRules } from "../plans.ts";
import type { RateLimitRuleInput } from "@tokenpanel/db";

test("genRuleId: 12-char hex (timestamp+machine slice, process-stable)", () => {
  const id = genRuleId();
  expect(id).toHaveLength(12);
  expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  const id2 = genRuleId();
  expect(id2).toHaveLength(12);
});

test("normalizeRules: applies id/scope/scopeTarget/currency/active defaults", () => {
  const input: RateLimitRuleInput[] = [
    { windowSeconds: 3600, dimension: "tokens", capValue: 1000 },
  ];
  const out = normalizeRules(input);
  expect(out).toHaveLength(1);
  expect(out[0]?.id).toHaveLength(12);
  expect(out[0]?.scope).toBe("customer");
  expect(out[0]?.scopeTarget).toBeNull();
  expect(out[0]?.currency).toBeNull();
  expect(out[0]?.active).toBe(true);
});

test("normalizeRules: preserves provided overrides", () => {
  const out = normalizeRules([
    {
      id: "fixed",
      windowSeconds: 18000,
      dimension: "spend_minor",
      capValue: 500,
      scope: "model",
      scopeTarget: "gpt",
      currency: "USD",
      active: false,
    },
  ]);
  expect(out[0]).toMatchObject({
    id: "fixed",
    windowSeconds: 18000,
    dimension: "spend_minor",
    capValue: 500,
    scope: "model",
    scopeTarget: "gpt",
    currency: "USD",
    active: false,
  });
});

test("normalizeRules: strips _index from output (no internal fields leak)", () => {
  const out = normalizeRules([{ windowSeconds: 3600, dimension: "tokens", capValue: 100 }]);
  expect(out[0]).not.toHaveProperty("_index");
  expect(Object.keys(out[0]!)).not.toContain("_index");
});