import { test, expect, describe } from "bun:test";
import {
  freezeSafeMapPolicy,
  SAFE_MAP_RESERVED_KEYS,
  isPlainObject,
} from "../safe-map.ts";

describe("freezeSafeMapPolicy", () => {
  test("returns a frozen shallow copy with identical values", () => {
    const input = {
      maxEntries: 10,
      keyMaxLen: 20,
      valueMaxLen: 30,
      reservedKeys: SAFE_MAP_RESERVED_KEYS,
    };
    const policy = freezeSafeMapPolicy(input);

    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy).not.toBe(input);
    expect(policy.maxEntries).toBe(10);
    expect(policy.keyMaxLen).toBe(20);
    expect(policy.valueMaxLen).toBe(30);
    expect(policy.reservedKeys).toBe(input.reservedKeys);
  });

  test("mutating the caller's input afterwards does not affect the policy", () => {
    const input = {
      maxEntries: 5,
      keyMaxLen: 6,
      valueMaxLen: 7,
      reservedKeys: SAFE_MAP_RESERVED_KEYS,
    };
    const policy = freezeSafeMapPolicy(input);
    input.maxEntries = 500;
    expect(policy.maxEntries).toBe(5);
  });
});

describe("isPlainObject", () => {
  test("accepts plain object literals", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  test("rejects non-plain objects", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Set())).toBe(false);
    expect(isPlainObject(/re/)).toBe(false);
    expect(isPlainObject(() => {})).toBe(false);
    expect(isPlainObject(new (class {})())).toBe(false);
  });
});
