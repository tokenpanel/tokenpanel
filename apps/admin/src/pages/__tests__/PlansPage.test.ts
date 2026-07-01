import { test, expect } from "bun:test";
import { toApiRule, validateDraft, formatWindow, formatAmountMinor } from "../PlansPage.tsx";

function draft(over: Record<string, unknown> = {}) {
  return {
    name: "Pro",
    description: "",
    priceAmount: "1000",
    priceCurrency: "USD",
    interval: "month",
    intervalCount: "1",
    includedCreditAmount: "0",
    includedCreditCurrency: "USD",
    includedTokens: "0",
    rateLimits: [],
    ...over,
  } as never;
}

test("toApiRule: currency uppercase for spend_minor, undefined for others", () => {
  const r1 = toApiRule({ id: "x", windowSeconds: "3600", dimension: "spend_minor", capValue: "100", scope: "customer", scopeTarget: "", currency: "usd", active: true } as never);
  expect(r1.currency).toBe("USD");
  const r2 = toApiRule({ id: "x", windowSeconds: "3600", dimension: "tokens", capValue: "100", scope: "customer", scopeTarget: "", currency: "USD", active: true } as never);
  expect(r2.currency).toBeUndefined();
});

test("toApiRule: empty scopeTarget → undefined; id empty → undefined", () => {
  const r = toApiRule({ id: "", windowSeconds: "3600", dimension: "tokens", capValue: "100", scope: "model", scopeTarget: "  ", currency: "", active: true } as never);
  expect(r.id).toBeUndefined();
  expect(r.scopeTarget).toBeUndefined();
});

test("toApiRule: coerces numbers from strings", () => {
  const r = toApiRule({ id: "x", windowSeconds: "3600", dimension: "tokens", capValue: "1000", scope: "customer", scopeTarget: "", currency: "", active: true } as never);
  expect(r.windowSeconds).toBe(3600);
  expect(r.capValue).toBe(1000);
});

test("validateDraft: valid → null", () => {
  expect(validateDraft(draft())).toBeNull();
});

test("validateDraft: empty name → error", () => {
  expect(validateDraft(draft({ name: "" }))).toBeTruthy();
  expect(validateDraft(draft({ name: "  " }))).toBeTruthy();
});

test("validateDraft: price not non-neg int → error", () => {
  expect(validateDraft(draft({ priceAmount: "-1" }))).toBeTruthy();
  expect(validateDraft(draft({ priceAmount: "1.5" }))).toBeTruthy();
});

test("validateDraft: price currency not 3-letter → error", () => {
  expect(validateDraft(draft({ priceCurrency: "US" }))).toBeTruthy();
});

test("validateDraft: intervalCount not positive int → error", () => {
  expect(validateDraft(draft({ intervalCount: "0" }))).toBeTruthy();
  expect(validateDraft(draft({ intervalCount: "-1" }))).toBeTruthy();
  expect(validateDraft(draft({ intervalCount: "1.5" }))).toBeTruthy();
});

test("validateDraft: included credit/tokens non-neg int → error otherwise", () => {
  expect(validateDraft(draft({ includedCreditAmount: "-1" }))).toBeTruthy();
  expect(validateDraft(draft({ includedTokens: "-1" }))).toBeTruthy();
  expect(validateDraft(draft({ includedTokens: "1.5" }))).toBeTruthy();
});

test("validateDraft: rule window out of bounds → error", () => {
  const r = { id: "r1", windowSeconds: "0", dimension: "tokens", capValue: "100", scope: "customer", scopeTarget: "", currency: "", active: true };
  expect(validateDraft(draft({ rateLimits: [r] }))).toBeTruthy();
  r.windowSeconds = "31536001";
  expect(validateDraft(draft({ rateLimits: [r] }))).toBeTruthy();
});

test("validateDraft: rule cap not positive → error", () => {
  const r = { id: "r1", windowSeconds: "3600", dimension: "tokens", capValue: "0", scope: "customer", scopeTarget: "", currency: "", active: true };
  expect(validateDraft(draft({ rateLimits: [r] }))).toBeTruthy();
});

test("validateDraft: spend_minor rule needs 3-letter currency", () => {
  const r = { id: "r1", windowSeconds: "3600", dimension: "spend_minor", capValue: "100", scope: "customer", scopeTarget: "", currency: "US", active: true };
  expect(validateDraft(draft({ rateLimits: [r] }))).toBeTruthy();
  r.currency = "USD";
  expect(validateDraft(draft({ rateLimits: [r] }))).toBeNull();
});

test("validateDraft: model/endpoint scope requires scopeTarget", () => {
  const r = { id: "r1", windowSeconds: "3600", dimension: "tokens", capValue: "100", scope: "model", scopeTarget: "", currency: "", active: true };
  expect(validateDraft(draft({ rateLimits: [r] }))).toBeTruthy();
  r.scopeTarget = "gpt";
  expect(validateDraft(draft({ rateLimits: [r] }))).toBeNull();
});

test("formatWindow: month-divisible → Xmo", () => {
  expect(formatWindow(2592000)).toBe("1mo");
  expect(formatWindow(7776000)).toBe("3mo");
});

test("formatWindow: known constants", () => {
  expect(formatWindow(604800)).toBe("1w");
  expect(formatWindow(86400)).toBe("1d");
  expect(formatWindow(18000)).toBe("5h");
  expect(formatWindow(3600)).toBe("1h");
});

test("formatWindow: divisible by day/hour", () => {
  expect(formatWindow(172800)).toBe("2d");
  expect(formatWindow(7200)).toBe("2h");
});

test("formatWindow: fallback seconds", () => {
  expect(formatWindow(7260)).toBe("7260s");
});

test("formatAmountMinor: integer major → 0 decimals", () => {
  expect(formatAmountMinor(1000, "USD")).toBe("USD 10");
  expect(formatAmountMinor(0, "USD")).toBe("USD 0");
});

test("formatAmountMinor: decimal major → 2 decimals", () => {
  expect(formatAmountMinor(12345, "USD")).toBe("USD 123.45");
  expect(formatAmountMinor(5, "USD")).toBe("USD 0.05");
});