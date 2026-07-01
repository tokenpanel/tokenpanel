import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { stripKey, parseObjectIdParam, KEY_PREFIX_LITERAL, PREFIX_LENGTH } from "../api-keys.ts";
import type { ApiKeyDoc } from "@tokenpanel/db";

function doc(over: Partial<ApiKeyDoc> = {}): ApiKeyDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    name: "prod",
    prefix: "tp_live_abcd",
    keyHash: "hash-value",
    modelWhitelist: [],
    status: "active",
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

test("stripKey: removes keyHash, adds hasKey true, preserves other fields", () => {
  const s = stripKey(doc());
  expect("keyHash" in s).toBe(false);
  expect(s.hasKey).toBe(true);
  expect(s.name).toBe("prod");
  expect(s.prefix).toBe("tp_live_abcd");
  expect(s.status).toBe("active");
});

test("stripKey: preserves modelWhitelist", () => {
  const s = stripKey(doc({ modelWhitelist: ["gpt", "claude"] }));
  expect(s.modelWhitelist).toEqual(["gpt", "claude"]);
});

test("parseObjectIdParam: valid → ObjectId, invalid → null", () => {
  const hex = new ObjectId().toHexString();
  expect(parseObjectIdParam(hex)).toBeInstanceOf(ObjectId);
  expect(parseObjectIdParam("bad")).toBeNull();
});

test("KEY_PREFIX_LITERAL is 'tp_live_'", () => {
  expect(KEY_PREFIX_LITERAL).toBe("tp_live_");
});

test("PREFIX_LENGTH is 12", () => {
  expect(PREFIX_LENGTH).toBe(12);
});