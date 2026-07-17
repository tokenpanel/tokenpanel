import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { adminSessionDoc, adminSessionCreateInput } from "../session.ts";

test("adminSessionDoc requires userId + expiresAt + timestamps", () => {
  const now = new Date();
  const r = adminSessionDoc.safeParse({
    _id: new ObjectId(),
    userId: new ObjectId(),
    expiresAt: new Date(now.getTime() + 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
  expect(r.success).toBe(true);
});

test("adminSessionDoc rejects missing expiresAt", () => {
  const now = new Date();
  const r = adminSessionDoc.safeParse({
    _id: new ObjectId(),
    userId: new ObjectId(),
    createdAt: now,
    updatedAt: now,
  });
  expect(r.success).toBe(false);
});

test("adminSessionCreateInput coerces userId string → ObjectId", () => {
  const userId = new ObjectId().toHexString();
  const r = adminSessionCreateInput.parse({
    userId,
    expiresAt: new Date(),
  });
  expect(r.userId).toBeInstanceOf(ObjectId);
  expect(r.userId.toHexString()).toBe(userId);
});
