import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { adminSessionDoc, adminSessionCreateInput } from "../session.ts";

test("adminSessionDoc requires userId + organizationId + expiresAt + timestamps", () => {
  const now = new Date();
  const r = adminSessionDoc.safeParse({
    _id: new ObjectId(),
    userId: new ObjectId(),
    organizationId: new ObjectId(),
    expiresAt: new Date(now.getTime() + 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
  expect(r.success).toBe(true);
});

test("adminSessionDoc rejects missing organizationId", () => {
  const now = new Date();
  const r = adminSessionDoc.safeParse({
    _id: new ObjectId(),
    userId: new ObjectId(),
    expiresAt: new Date(now.getTime() + 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
  expect(r.success).toBe(false);
});

test("adminSessionDoc rejects missing expiresAt", () => {
  const now = new Date();
  const r = adminSessionDoc.safeParse({
    _id: new ObjectId(),
    userId: new ObjectId(),
    organizationId: new ObjectId(),
    createdAt: now,
    updatedAt: now,
  });
  expect(r.success).toBe(false);
});

test("adminSessionCreateInput coerces userId + organizationId strings → ObjectId", () => {
  const userId = new ObjectId().toHexString();
  const organizationId = new ObjectId().toHexString();
  const r = adminSessionCreateInput.parse({
    userId,
    organizationId,
    expiresAt: new Date(),
  });
  expect(r.userId).toBeInstanceOf(ObjectId);
  expect(r.userId.toHexString()).toBe(userId);
  expect(r.organizationId).toBeInstanceOf(ObjectId);
  expect(r.organizationId.toHexString()).toBe(organizationId);
});
