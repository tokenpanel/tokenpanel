import { test, expect, describe } from "bun:test";
import { resolveProviderHttpTimeoutMs } from "../http-timeout.ts";

describe("resolveProviderHttpTimeoutMs", () => {
  test("inherits global when provider override absent or null", () => {
    expect(resolveProviderHttpTimeoutMs(undefined, 120_000)).toBe(120_000);
    expect(resolveProviderHttpTimeoutMs(null, 120_000)).toBe(120_000);
  });

  test("provider override wins including 0 (disable)", () => {
    expect(resolveProviderHttpTimeoutMs(30_000, 120_000)).toBe(30_000);
    expect(resolveProviderHttpTimeoutMs(0, 120_000)).toBe(0);
  });

  test("global 0 means no timeout when no override", () => {
    expect(resolveProviderHttpTimeoutMs(undefined, 0)).toBe(0);
    expect(resolveProviderHttpTimeoutMs(null, 0)).toBe(0);
  });
});
