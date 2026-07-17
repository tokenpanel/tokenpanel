import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  stripKey,
  parseObjectIdParam,
  KEY_PREFIX_LITERAL,
  PREFIX_LENGTH,
} from "../management-keys.ts";
import type { ManagementApiKeyDoc } from "@tokenpanel/db";

function doc(over: Partial<ManagementApiKeyDoc> = {}): ManagementApiKeyDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    name: "ci",
    prefix: "tp_mgmt_abcd",
    keyHash: "hash",
    scopes: ["models:read", "chat:write"],
    status: "active",
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

test("KEY_PREFIX_LITERAL is 'tp_mgmt_'", () => {
  expect(KEY_PREFIX_LITERAL).toBe("tp_mgmt_");
});

test("PREFIX_LENGTH is 16 — matches the public auth dispatcher so slice(0, 16) resolves either key kind", () => {
  expect(PREFIX_LENGTH).toBe(16);
  // "tp_mgmt_" is 8 chars; slice(0, 16) keeps the literal + 8 random hex chars.
  expect(`${KEY_PREFIX_LITERAL}0123456789abcdef`.slice(0, PREFIX_LENGTH)).toBe("tp_mgmt_01234567");
});

test("stripKey: removes keyHash, adds hasKey true, preserves scopes", () => {
  const s = stripKey(doc());
  expect("keyHash" in s).toBe(false);
  expect(s.hasKey).toBe(true);
  expect(s.scopes).toEqual(["models:read", "chat:write"]);
  expect(s.prefix).toBe("tp_mgmt_abcd");
  expect(s.status).toBe("active");
});

test("parseObjectIdParam: valid hex → ObjectId, invalid → null", () => {
  const hex = new ObjectId().toHexString();
  expect(parseObjectIdParam(hex)).toBeInstanceOf(ObjectId);
  expect(parseObjectIdParam("not-an-id")).toBeNull();
});
