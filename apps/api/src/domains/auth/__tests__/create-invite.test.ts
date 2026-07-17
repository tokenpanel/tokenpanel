/**
 * createInvite privilege-escalation guards.
 * Inviter may only grant role/permissions within their effective set.
 */
import { test, expect } from "bun:test";
import { Effect, Layer, Exit } from "effect";
import { ObjectId } from "mongodb";
import type { InviteDoc } from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import { createInvite } from "../operations.ts";
import {
  InviteRepository,
  type InviteRepositoryService,
} from "../../ports/invite-repository.ts";
import { CryptoTest } from "../../../runtime/layers/crypto.ts";
import { ClockTest } from "../../../runtime/layers/clock.ts";

const ORG_ID = new ObjectId().toHexString();
const ACTOR_ID = new ObjectId().toHexString();

function inviteStore() {
  const docs: InviteDoc[] = [];
  const service: InviteRepositoryService = {
    listByOrg: () => Effect.succeed(docs),
    insert: (record) =>
      Effect.sync(() => {
        const now = new Date();
        const doc: InviteDoc = {
          _id: new ObjectId(),
          organizationId: new ObjectId(record.organizationId),
          invitedBy: new ObjectId(record.invitedBy),
          email: record.email,
          role: record.role,
          permissions: [...(record.permissions ?? [])],
          tokenHash: record.tokenHash,
          status: "pending",
          expiresAt: record.expiresAt,
          createdAt: now,
          updatedAt: now,
        };
        docs.push(doc);
        return doc;
      }),
    findPendingByTokenHash: () => Effect.succeed(null),
    revokePending: () => Effect.succeed(false),
    markAccepted: () => Effect.void,
    deleteByOrg: () => Effect.void,
  };
  return {
    docs,
    layer: Layer.succeed(InviteRepository, service),
  };
}

function runCreate(
  layer: Layer.Layer<InviteRepository>,
  input: Parameters<typeof createInvite>[0],
) {
  return Effect.runPromiseExit(
    createInvite(input).pipe(Effect.provide(Layer.mergeAll(layer, CryptoTest, ClockTest))),
  );
}

const base = {
  organizationId: ORG_ID,
  invitedBy: ACTOR_ID,
  email: "newbie@example.com",
} as const;

test("admin can create admin invite", async () => {
  const { docs, layer } = inviteStore();
  const exit = await runCreate(layer, {
    ...base,
    role: "admin",
    actorRole: "admin",
    actorPermissions: [],
  });
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    expect(exit.value.invite.role).toBe("admin");
    expect(exit.value.token.length).toBeGreaterThan(0);
  }
  expect(docs).toHaveLength(1);
});

test("admin can grant any member permissions", async () => {
  const { docs, layer } = inviteStore();
  const perms: readonly PanelPermission[] = [
    "providers:write",
    "balances:write",
  ];
  const exit = await runCreate(layer, {
    ...base,
    role: "member",
    permissions: perms,
    actorRole: "admin",
    actorPermissions: [],
  });
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    expect(exit.value.invite.permissions).toEqual([...perms]);
  }
  expect(docs).toHaveLength(1);
});

test("member with invites:write cannot create admin invite", async () => {
  const { docs, layer } = inviteStore();
  const exit = await runCreate(layer, {
    ...base,
    role: "admin",
    actorRole: "member",
    actorPermissions: ["invites:write"],
  });
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain("Cannot grant permissions you do not hold");
  }
  expect(docs).toHaveLength(0);
});

test("member with invites:write cannot grant providers:write", async () => {
  const { docs, layer } = inviteStore();
  const exit = await runCreate(layer, {
    ...base,
    role: "member",
    permissions: ["invites:write", "providers:write"],
    actorRole: "member",
    actorPermissions: ["invites:write"],
  });
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain("Cannot grant permissions you do not hold");
  }
  expect(docs).toHaveLength(0);
});

test("member can grant a subset of own permissions", async () => {
  const { docs, layer } = inviteStore();
  const exit = await runCreate(layer, {
    ...base,
    role: "member",
    permissions: ["invites:write", "customers:read"],
    actorRole: "member",
    actorPermissions: [
      "invites:write",
      "invites:read",
      "customers:read",
      "usage:read",
    ],
  });
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    expect(exit.value.invite.role).toBe("member");
    expect(exit.value.invite.permissions).toEqual([
      "invites:write",
      "customers:read",
    ]);
  }
  expect(docs).toHaveLength(1);
});

test("member can create empty-permission member invite", async () => {
  const { docs, layer } = inviteStore();
  const exit = await runCreate(layer, {
    ...base,
    role: "member",
    permissions: [],
    actorRole: "member",
    actorPermissions: ["invites:write"],
  });
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    expect(exit.value.invite.permissions).toEqual([]);
  }
  expect(docs).toHaveLength(1);
});
