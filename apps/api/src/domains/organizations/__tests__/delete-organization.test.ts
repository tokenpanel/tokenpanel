/**
 * Org delete must cascade management keys so public auth cannot retain a
 * detached tenant after the organization document is gone.
 */
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { OrganizationDoc, UserDoc } from "@tokenpanel/db";
import { deleteOrganization } from "../operations.ts";
import {
  OrganizationRepository,
  type OrganizationRepositoryService,
} from "../../ports/organization-repository.ts";
import {
  UserRepository,
  type UserRepositoryService,
} from "../../ports/user-repository.ts";
import {
  InviteRepository,
  type InviteRepositoryService,
} from "../../ports/invite-repository.ts";
import {
  KeyRepository,
  type KeyRepositoryService,
} from "../../ports/key-repository.ts";

const ORG_A = new ObjectId();
const ORG_B = new ObjectId();
const OWNER_ID = new ObjectId();

function neverCall(): never {
  throw new Error("unexpected repository call");
}

function ownerUser(): UserDoc {
  const now = new Date();
  return {
    _id: OWNER_ID,
    username: "owner",
    email: "owner@example.com",
    passwordHash: "x",
    memberships: [
      { organizationId: ORG_A, role: "admin" },
      { organizationId: ORG_B, role: "admin" },
    ],
    activeOrganizationId: ORG_A,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function orgA(): OrganizationDoc {
  const now = new Date();
  return {
    _id: ORG_A,
    name: "Doomed",
    slug: "doomed",
    ownerId: OWNER_ID,
    defaultCurrency: "USD",
    createdAt: now,
    updatedAt: now,
  };
}

test("deleteOrganization cascades management keys before org delete", async () => {
  const calls: string[] = [];

  const orgs = Layer.succeed(OrganizationRepository, {
    findById: (id: string) =>
      Effect.succeed(id === ORG_A.toHexString() ? orgA() : null),
    findByIds: neverCall,
    findBySlug: neverCall,
    slugTaken: neverCall,
    insert: neverCall,
    update: neverCall,
    delete: (id: string) =>
      Effect.sync(() => {
        calls.push(`org.delete:${id}`);
      }),
    countBusinessData: () =>
      Effect.succeed({
        providers: 0,
        customers: 0,
        models: 0,
        plans: 0,
        apiKeys: 0,
      }),
  } as unknown as OrganizationRepositoryService);

  const users = Layer.succeed(UserRepository, {
    countUsers: neverCall,
    findById: neverCall,
    findByUsername: neverCall,
    findByEmail: neverCall,
    findByUsernameOrEmail: neverCall,
    emailTaken: neverCall,
    insertUser: neverCall,
    updateEmail: neverCall,
    updatePasswordHash: neverCall,
    setActiveOrganization: neverCall,
    addMembership: neverCall,
    findMembersOfOrg: () => Effect.succeed([ownerUser()]),
    pullMembershipAndRepoint: (
      _userId: string,
      orgId: string,
      nextActive: string,
    ) =>
      Effect.sync(() => {
        calls.push(`users.repoint:${orgId}->${nextActive}`);
      }),
  } as unknown as UserRepositoryService);

  const invites = Layer.succeed(InviteRepository, {
    listByOrg: neverCall,
    insert: neverCall,
    findPendingByTokenHash: neverCall,
    revokePending: neverCall,
    markAccepted: neverCall,
    deleteByOrg: (orgId: string) =>
      Effect.sync(() => {
        calls.push(`invites.deleteByOrg:${orgId}`);
      }),
  } as unknown as InviteRepositoryService);

  const keys = Layer.succeed(KeyRepository, {
    listCustomerKeys: neverCall,
    findCustomerKey: neverCall,
    findCustomerKeyByPrefix: neverCall,
    insertCustomerKey: neverCall,
    updateCustomerKey: neverCall,
    revokeCustomerKey: neverCall,
    touchCustomerKeyLastUsed: neverCall,
    listManagementKeys: neverCall,
    findManagementKey: neverCall,
    findManagementKeyByPrefix: neverCall,
    insertManagementKey: neverCall,
    updateManagementKey: neverCall,
    revokeManagementKey: neverCall,
    touchManagementKeyLastUsed: neverCall,
    deleteManagementKeysByOrg: (orgId: string) =>
      Effect.sync(() => {
        calls.push(`keys.deleteManagementKeysByOrg:${orgId}`);
      }),
  } as unknown as KeyRepositoryService);

  const result = await Effect.runPromise(
    deleteOrganization({
      user: ownerUser(),
      organizationId: ORG_A.toHexString(),
    }).pipe(Effect.provide(Layer.mergeAll(orgs, users, invites, keys))),
  );

  expect(result).toEqual({ ok: true });
  expect(calls).toContain(
    `keys.deleteManagementKeysByOrg:${ORG_A.toHexString()}`,
  );
  expect(calls).toContain(`invites.deleteByOrg:${ORG_A.toHexString()}`);
  expect(calls).toContain(`org.delete:${ORG_A.toHexString()}`);
  // Keys wiped before org document so no window where auth can succeed on a
  // deleted tenant if something races mid-delete.
  const keyIdx = calls.indexOf(
    `keys.deleteManagementKeysByOrg:${ORG_A.toHexString()}`,
  );
  const orgIdx = calls.indexOf(`org.delete:${ORG_A.toHexString()}`);
  expect(keyIdx).toBeGreaterThanOrEqual(0);
  expect(orgIdx).toBeGreaterThan(keyIdx);
});
