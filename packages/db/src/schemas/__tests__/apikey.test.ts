import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  apiKeyDoc,
  apiKeyCreateInput,
  apiKeyUpdateInput,
} from "../apikey.ts";

const custId = () => new ObjectId().toHexString();

test("apiKeyDoc prefix bounds 8-20, status enum, modelWhitelist default []", () => {
  const b = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    customerId: new ObjectId(),
    name: "prod key",
    prefix: "tp_live_abc",
    keyHash: "hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  expect(apiKeyDoc.safeParse(b).success).toBe(true);
  const r = apiKeyDoc.parse(b);
  expect(r.modelWhitelist).toEqual([]);
  expect(r.status).toBe("active");
  expect(r.lastUsedAt).toBeUndefined();
  expect(apiKeyDoc.safeParse({ ...b, prefix: "short" }).success).toBe(false);
  expect(apiKeyDoc.safeParse({ ...b, prefix: "x".repeat(21) }).success).toBe(false);
  expect(apiKeyDoc.safeParse({ ...b, status: "paused" }).success).toBe(false);
});

test("apiKeyCreateInput requires customerId + name", () => {
  const b = { customerId: custId(), name: "k" };
  expect(apiKeyCreateInput.safeParse(b).success).toBe(true);
  expect(apiKeyCreateInput.safeParse({ ...b, name: "" }).success).toBe(false);
  expect(apiKeyCreateInput.safeParse({ ...b, customerId: "bad" }).success).toBe(false);
  expect(apiKeyCreateInput.safeParse({ ...b, modelWhitelist: ["a", "b"] }).success).toBe(true);
  expect(apiKeyCreateInput.safeParse({ ...b, modelWhitelist: [""] }).success).toBe(false);
});

test("apiKeyUpdateInput all optional, validates status enum", () => {
  expect(apiKeyUpdateInput.safeParse({}).success).toBe(true);
  expect(apiKeyUpdateInput.safeParse({ status: "revoked" }).success).toBe(true);
  expect(apiKeyUpdateInput.safeParse({ status: "deleted" }).success).toBe(false);
  expect(apiKeyUpdateInput.safeParse({ name: "" }).success).toBe(false);
});