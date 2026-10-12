import { test, expect } from "bun:test";
import { allCurrencyCodes, COMMON_CURRENCIES, currencyName } from "../currency.ts";

test("allCurrencyCodes: ISO 4217 list includes the common set, sorted, 3-letter", () => {
  const all = allCurrencyCodes();
  for (const c of COMMON_CURRENCIES) expect(all).toContain(c);
  expect(all.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
  expect([...all].sort()).toEqual(all);
});

test("currencyName: resolves a display name, empty for unknown codes", () => {
  expect(currencyName("USD").length).toBeGreaterThan(0);
  expect(currencyName("ZZZ")).toBe("");
});
