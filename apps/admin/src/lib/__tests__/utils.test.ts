import { test, expect } from "bun:test";
import { cn } from "../utils.ts";

test("cn: joins class names", () => {
  expect(cn("a", "b", "c")).toBe("a b c");
});

test("cn: handles empty/falsy inputs", () => {
  expect(cn("", null, undefined, false, "x")).toBe("x");
});

test("cn: dedupes conflicting Tailwind classes (twMerge)", () => {
  expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
  expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
});

test("cn: handles array + object inputs (clsx)", () => {
  expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
});

test("cn: empty inputs → empty string", () => {
  expect(cn()).toBe("");
});