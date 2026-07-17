/**
 * Public principal resolution: management keys must not authenticate when
 * their organization no longer exists (detached-tenant defense).
 */
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type { ManagementApiKeyDoc, OrganizationDoc } from "@tokenpanel/db";
import { resolvePublicPrincipal } from "../session.ts";
import {
  KeyRepository,
  type KeyRepositoryService,
} from "../../ports/key-repository.ts";
import {
  CustomerRepository,
  type CustomerRepositoryService,
} from "../../ports/customer-repository.ts";
import {
  OrganizationRepository,
  type OrganizationRepositoryService,
} from "../../ports/organization-repository.ts";
import { CryptoTest } from "../../../runtime/layers/crypto.ts";
import { hashToken } from "../../../lib/crypto.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "../../../config/security-policy.ts";

const ORG_ID = new ObjectId();
const FULL_KEY = `${MANAGEMENT_KEY_PREFIX_LITERAL}01234567secret-pad-enough`;
const PREFIX = FULL_KEY.slice(0, API_KEY_LOOKUP_PREFIX_CHARS);

function mgmtKeyDoc(over: Partial<ManagementApiKeyDoc> = {}): ManagementApiKeyDoc {
  const now = new Date();
  return {
    _id: new ObjectId(),
    organizationId: ORG_ID,
    name: "ci",
    prefix: PREFIX,
    keyHash: hashToken(FULL_KEY),
    scopes: ["models:read"],
    status: "active",
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function orgDoc(): OrganizationDoc {
  const now = new Date();
  return {
    _id: ORG_ID,
    name: "Acme",
    slug: "acme",
    ownerId: new ObjectId(),
    defaultCurrency: "USD",
    createdAt: now,
    updatedAt: now,
  };
}

function neverCall(): never {
  throw new Error("unexpected repository call");
}

function keysLayer(mgmt: ManagementApiKeyDoc | null) {
  const service = {
    listCustomerKeys: neverCall,
    findCustomerKey: neverCall,
    findCustomerKeyByPrefix: () => Effect.succeed(null),
    insertCustomerKey: neverCall,
    updateCustomerKey: neverCall,
    revokeCustomerKey: neverCall,
    touchCustomerKeyLastUsed: neverCall,
    listManagementKeys: neverCall,
    findManagementKey: neverCall,
    findManagementKeyByPrefix: (prefix: string) =>
      Effect.succeed(mgmt && mgmt.prefix === prefix ? mgmt : null),
    insertManagementKey: neverCall,
    updateManagementKey: neverCall,
    revokeManagementKey: neverCall,
    touchManagementKeyLastUsed: neverCall,
    deleteManagementKeysByOrg: neverCall,
  } as unknown as KeyRepositoryService;
  return Layer.succeed(KeyRepository, service);
}

function customersLayer() {
  const service = {
    list: neverCall,
    findById: neverCall,
    findByCustomerId: neverCall,
    findConflict: neverCall,
    insertWithOpeningBalance: neverCall,
    update: neverCall,
    close: neverCall,
  } as unknown as CustomerRepositoryService;
  return Layer.succeed(CustomerRepository, service);
}

function orgsLayer(org: OrganizationDoc | null) {
  const service = {
    findById: (id: string) =>
      Effect.succeed(org && org._id.toHexString() === id ? org : null),
    findByIds: neverCall,
    findBySlug: neverCall,
    slugTaken: neverCall,
    insert: neverCall,
    update: neverCall,
    delete: neverCall,
    countBusinessData: neverCall,
  } as unknown as OrganizationRepositoryService;
  return Layer.succeed(OrganizationRepository, service);
}

function runResolve(mgmt: ManagementApiKeyDoc | null, org: OrganizationDoc | null) {
  const layer = Layer.mergeAll(
    keysLayer(mgmt),
    customersLayer(),
    orgsLayer(org),
    CryptoTest,
  );
  return Effect.runPromise(
    resolvePublicPrincipal(`Bearer ${FULL_KEY}`).pipe(
      Effect.provide(layer),
      Effect.either,
    ),
  );
}

test("management key + existing org → principal", async () => {
  const key = mgmtKeyDoc();
  const result = await runResolve(key, orgDoc());
  expect(result._tag).toBe("Right");
  if (result._tag !== "Right") throw new Error("expected success");
  expect(result.right.kind).toBe("management");
  if (result.right.kind !== "management") throw new Error("unreachable");
  expect(result.right.orgId.equals(ORG_ID)).toBe(true);
  expect(result.right.managementKey._id.equals(key._id)).toBe(true);
});

test("management key + missing org → unauthorized (detached tenant)", async () => {
  const result = await runResolve(mgmtKeyDoc(), null);
  expect(result._tag).toBe("Left");
  if (result._tag !== "Left") throw new Error("expected failure");
  expect(result.left._tag).toBe("AuthenticationError");
  expect(result.left.code).toBe("unauthorized");
});

test("revoked management key → unauthorized even if org exists", async () => {
  const result = await runResolve(mgmtKeyDoc({ status: "revoked" }), orgDoc());
  expect(result._tag).toBe("Left");
  if (result._tag !== "Left") throw new Error("expected failure");
  expect(result.left._tag).toBe("AuthenticationError");
});
