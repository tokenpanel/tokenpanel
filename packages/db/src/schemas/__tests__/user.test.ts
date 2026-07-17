import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  userRole,
  membershipDoc,
  membershipInput,
  userDoc,
  userCreateInput,
  userUpdateInput,
  inviteDoc,
  inviteCreateInput,
} from "../user.ts";

test("userRole enum", () => {
  expect(userRole.safeParse("admin").success).toBe(true);
  expect(userRole.safeParse("member").success).toBe(true);
  expect(userRole.safeParse("owner").success).toBe(false);
  expect(userRole.safeParse("ADMIN").success).toBe(false);
});

const orgIdHex = () => new ObjectId().toHexString();

const base = {
  memberships: [{ organizationId: orgIdHex(), role: "member" }],
  activeOrganizationId: orgIdHex(),
  email: "a@b.com",
  password: "password123",
};

test("membershipDoc coerces ObjectId + requires role", () => {
  const r = membershipDoc.safeParse({
    organizationId: new ObjectId(),
    role: "admin",
  });
  expect(r.success).toBe(true);
  expect(membershipDoc.safeParse({ organizationId: new ObjectId(), role: "owner" }).success).toBe(false);
});

test("membershipDoc defaults permissions to [] when omitted", () => {
  const r = membershipDoc.parse({
    organizationId: new ObjectId(),
    role: "member",
  });
  expect(r.permissions).toEqual([]);
});

test("membershipDoc accepts explicit permissions grants", () => {
  const r = membershipDoc.parse({
    organizationId: new ObjectId(),
    role: "member",
    permissions: ["customers:read", "usage:read"],
  });
  expect(r.permissions).toEqual(["customers:read", "usage:read"]);
});

test("membershipDoc rejects unknown permission strings", () => {
  expect(
    membershipDoc.safeParse({
      organizationId: new ObjectId(),
      role: "member",
      permissions: ["customers:read", "chat:write"],
    }).success,
  ).toBe(false);
  expect(
    membershipDoc.safeParse({
      organizationId: new ObjectId(),
      role: "member",
      permissions: ["not-a-permission"],
    }).success,
  ).toBe(false);
});

test("membershipInput coerces string orgId to ObjectId", () => {
  const r = membershipInput.parse({
    organizationId: orgIdHex(),
    role: "admin",
  });
  expect(r.organizationId).toBeInstanceOf(ObjectId);
  expect(r.permissions).toEqual([]);
  expect(membershipInput.safeParse({ organizationId: "bad", role: "admin" }).success).toBe(false);
});

test("membershipInput rejects unknown permission strings", () => {
  expect(
    membershipInput.safeParse({
      organizationId: orgIdHex(),
      role: "member",
      permissions: ["providers:secrets"],
    }).success,
  ).toBe(false);
});

test("userCreateInput username regex + bounds", () => {
  expect(userCreateInput.safeParse({ ...base, username: "ab" }).success).toBe(false);
  expect(userCreateInput.safeParse({ ...base, username: "a".repeat(61) }).success).toBe(false);
  expect(userCreateInput.safeParse({ ...base, username: "ab cd" }).success).toBe(false);
  expect(userCreateInput.safeParse({ ...base, username: "user.name_1-2" }).success).toBe(true);
});

test("userCreateInput password min 8", () => {
  expect(userCreateInput.safeParse({ ...base, username: "alice", password: "short" }).success).toBe(false);
  expect(userCreateInput.safeParse({ ...base, username: "alice", password: "12345678" }).success).toBe(true);
});

test("userCreateInput email format + max", () => {
  expect(userCreateInput.safeParse({ ...base, username: "alice", email: "not-email" }).success).toBe(false);
  expect(userCreateInput.safeParse({ ...base, username: "alice", email: "a".repeat(250) + "@b.com" }).success).toBe(false);
});

test("userCreateInput has no top-level role field (role lives on membership)", () => {
  // role on a membership is honored; top-level role is ignored/stripped
  const r = userCreateInput.parse({
    ...base,
    username: "alice",
    memberships: [{ organizationId: orgIdHex(), role: "admin" }],
  });
  expect(r.memberships[0]!.role).toBe("admin");
  expect("role" in r).toBe(false);
});

test("userDoc applies status default, has no global role", () => {
  const r = userDoc.parse({
    _id: new ObjectId(),
    memberships: [{ organizationId: new ObjectId(), role: "member" }],
    activeOrganizationId: new ObjectId(),
    username: "alice",
    email: "a@b.com",
    passwordHash: "$argon2id$abc",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.status).toBe("active");
  expect("role" in r).toBe(false);
  // optionalWith default: legacy docs without permissions decode to []
  expect(r.memberships[0]!.permissions).toEqual([]);
});

test("userDoc requires memberships min 1", () => {
  expect(
    userDoc.safeParse({
      _id: new ObjectId(),
      memberships: [],
      activeOrganizationId: new ObjectId(),
      username: "alice",
      email: "a@b.com",
      passwordHash: "x",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).success,
  ).toBe(false);
});

test("userUpdateInput allows partial updates, forbids password + role", () => {
  expect(userUpdateInput.safeParse({ email: "new@b.com" }).success).toBe(true);
  expect(userUpdateInput.safeParse({ status: "disabled" }).success).toBe(true);
  expect(userUpdateInput.safeParse({}).success).toBe(true);
  // password / role are not part of update input (stripped / ignored)
  const withPassword = userUpdateInput.safeParse({
    email: "new@b.com",
    password: "nope",
  } as { email: string; password: string });
  expect(withPassword.success).toBe(true);
  if (withPassword.success) {
    expect("password" in withPassword.data).toBe(false);
    expect("role" in withPassword.data).toBe(false);
  }
});

test("inviteCreateInput ttlHours bounds + default 168", () => {
  const b = { organizationId: new ObjectId().toHexString(), invitedBy: new ObjectId().toHexString(), email: "x@y.com" };
  expect(inviteCreateInput.safeParse({ ...b, ttlHours: 0 }).success).toBe(false);
  expect(inviteCreateInput.safeParse({ ...b, ttlHours: 721 }).success).toBe(false);
  expect(inviteCreateInput.safeParse({ ...b, ttlHours: 1 }).success).toBe(true);
  expect(inviteCreateInput.safeParse({ ...b, ttlHours: 1.5 }).success).toBe(false);
  const r = inviteCreateInput.parse(b);
  expect(r.ttlHours).toBe(168);
  expect(r.role).toBeUndefined();
});

test("userCreateInput requires memberships min 1 + activeOrganizationId", () => {
  expect(
    userCreateInput.safeParse({ ...base, username: "alice", memberships: [] }).success,
  ).toBe(false);
  expect(
    userCreateInput.safeParse({
      username: "alice",
      email: "a@b.com",
      password: "password123",
      activeOrganizationId: new ObjectId().toHexString(),
    }).success,
  ).toBe(false);
});

test("inviteDoc requires expiresAt Date + tokenHash", () => {
  expect(
    inviteDoc.safeParse({
      _id: new ObjectId(),
      organizationId: new ObjectId(),
      invitedBy: new ObjectId(),
      email: "a@b.com",
      tokenHash: "hash",
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).success,
  ).toBe(true);
  expect(
    inviteDoc.safeParse({
      _id: new ObjectId(),
      organizationId: new ObjectId(),
      invitedBy: new ObjectId(),
      email: "a@b.com",
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).success,
  ).toBe(false);
});

test("inviteDoc defaults permissions to [] when omitted", () => {
  const r = inviteDoc.parse({
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    invitedBy: new ObjectId(),
    email: "a@b.com",
    tokenHash: "hash",
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(r.permissions).toEqual([]);
  expect(r.role).toBe("member");
});

test("inviteDoc accepts + rejects permissions", () => {
  const base = {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    invitedBy: new ObjectId(),
    email: "a@b.com",
    tokenHash: "hash",
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const ok = inviteDoc.parse({
    ...base,
    permissions: ["models:read", "providers:read"],
  });
  expect(ok.permissions).toEqual(["models:read", "providers:read"]);
  expect(
    inviteDoc.safeParse({ ...base, permissions: ["nope:write"] }).success,
  ).toBe(false);
});
