import { test, expect, describe } from "bun:test";
import {
  SAFE_MAP_RESERVED_KEYS,
  PROVIDER_HEADERS_POLICY,
  CALLER_METADATA_POLICY,
  isValidSafeMapKey,
  isReservedSafeMapKey,
  isValidModelMetadataKey,
  isSafeJsonMapValue,
  SAFE_JSON_MAP_MAX_DEPTH,
} from "../index.ts";

describe("isValidSafeMapKey hostile", () => {
  test("reserved prototype keys blocked", () => {
    for (const k of SAFE_MAP_RESERVED_KEYS) {
      expect(isReservedSafeMapKey(k)).toBe(true);
      expect(isValidSafeMapKey(k)).toBe(false);
    }
  });
  test("accepts normal keys", () => {
    expect(isValidSafeMapKey("tier")).toBe(true);
    expect(isValidSafeMapKey("X-Custom-Header", PROVIDER_HEADERS_POLICY)).toBe(
      true,
    );
    expect(isValidSafeMapKey("a.b.c")).toBe(true);
  });

  test("rejects empty, overlong, control, $, reserved", () => {
    expect(isValidSafeMapKey("")).toBe(false);
    expect(isValidSafeMapKey("x".repeat(81))).toBe(false);
    expect(isValidSafeMapKey("a\0b")).toBe(false);
    expect(isValidSafeMapKey("a\nb")).toBe(false);
    expect(isValidSafeMapKey("a\rb")).toBe(false);
    expect(isValidSafeMapKey("a\tb")).toBe(false); // tab is control
    expect(isValidSafeMapKey("a\u007Fb")).toBe(false); // DEL
    expect(isValidSafeMapKey("$set")).toBe(false);
    expect(isValidSafeMapKey("$gt")).toBe(false);
    expect(isValidSafeMapKey("__proto__")).toBe(false);
    expect(isValidSafeMapKey("constructor")).toBe(false);
    expect(isValidSafeMapKey("prototype")).toBe(false);
  });

  test("model helper parity", () => {
    expect(isValidModelMetadataKey("ok")).toBe(true);
    expect(isValidModelMetadataKey("$where")).toBe(false);
  });

  test("policy keyMaxLen respected", () => {
    const short = { ...PROVIDER_HEADERS_POLICY, keyMaxLen: 5 };
    expect(isValidSafeMapKey("abcde", short)).toBe(true);
    expect(isValidSafeMapKey("abcdef", short)).toBe(false);
  });
});

describe("isSafeJsonMapValue", () => {
  test("accepts scalars and shallow objects", () => {
    expect(isSafeJsonMapValue(null, CALLER_METADATA_POLICY)).toBe(true);
    expect(isSafeJsonMapValue(true, CALLER_METADATA_POLICY)).toBe(true);
    expect(isSafeJsonMapValue(1, CALLER_METADATA_POLICY)).toBe(true);
    expect(isSafeJsonMapValue("hi", CALLER_METADATA_POLICY)).toBe(true);
    expect(isSafeJsonMapValue({ a: 1 }, CALLER_METADATA_POLICY)).toBe(true);
    expect(isSafeJsonMapValue([1, "x", null], CALLER_METADATA_POLICY)).toBe(
      true,
    );
  });

  test("rejects NaN, functions, Date, bad keys, deep trees", () => {
    expect(isSafeJsonMapValue(Number.NaN, CALLER_METADATA_POLICY)).toBe(false);
    expect(isSafeJsonMapValue(() => 1, CALLER_METADATA_POLICY)).toBe(false);
    expect(isSafeJsonMapValue(new Date(), CALLER_METADATA_POLICY)).toBe(false);
    expect(isSafeJsonMapValue({ $set: 1 }, CALLER_METADATA_POLICY)).toBe(false);
    // object literal `{ __proto__: … }` does not create an own key — use JSON
    expect(
      isSafeJsonMapValue(
        JSON.parse('{"__proto__":1}') as unknown,
        CALLER_METADATA_POLICY,
      ),
    ).toBe(false);
    // depth > SAFE_JSON_MAP_MAX_DEPTH
    let nested: unknown = "leaf";
    for (let i = 0; i <= SAFE_JSON_MAP_MAX_DEPTH + 1; i++) {
      nested = { n: nested };
    }
    expect(isSafeJsonMapValue(nested, CALLER_METADATA_POLICY)).toBe(false);
  });

  test("rejects overlong strings", () => {
    expect(
      isSafeJsonMapValue(
        "x".repeat(CALLER_METADATA_POLICY.valueMaxLen + 1),
        CALLER_METADATA_POLICY,
      ),
    ).toBe(false);
  });
});
