/**
 * Keys domain: customer + management key issuance/update/revoke/list against a
 * recording fake KeyRepository; real hashToken verification; prefix-collision
 * retry exhaustion. Style matches admin-session.test.ts.
 */
import { test, expect } from "bun:test";
import { Cause, Effect, Layer } from "effect";
import { ObjectId } from "mongodb";
import type {
  ApiKeyDoc,
  CustomerDoc,
  ManagementApiKeyDoc,
} from "@tokenpanel/db";
import {
  listCustomerApiKeys,
  issueCustomerApiKey,
  updateCustomerApiKey,
  revokeCustomerApiKey,
  listManagementKeys,
  issueManagementKey,
  updateManagementKey,
  revokeManagementKey,
  stripCustomerKey,
  stripManagementKey,
} from "../operations.ts";
import {
  KeyRepository,
  type KeyRepositoryService,
  type NewCustomerKeyRecord,
  type NewManagementKeyRecord,
} from "../../ports/key-repository.ts";
import {
  CustomerRepository,
  type CustomerRepositoryService,
} from "../../ports/customer-repository.ts";
import { CryptoTest } from "../../../runtime/layers/crypto.ts";
import { hashToken } from "../../../lib/crypto.ts";
import {
  PersistenceDuplicateKeyError,
  PersistenceUnavailableError,
} from "../../../errors/families.ts";

const ORG_ID = new ObjectId().toHexString();
const CUSTOMER_ID = new ObjectId().toHexString();
const KEY_ID = new ObjectId().toHexString();
const MGMT_KEY_ID = new ObjectId().toHexString();
const NOW = new Date();

function neverCall(): never {
  throw new Error("unexpected repository call");
}

function apiKeyDoc(over: Partial<ApiKeyDoc> = {}): ApiKeyDoc {
  return {
    _id: new ObjectId(KEY_ID),
    organizationId: new ObjectId(ORG_ID),
    customerId: new ObjectId(CUSTOMER_ID),
    name: "customer key",
    prefix: "tp_live_prefix000001",
    keyHash: "hash",
    modelWhitelist: [],
    lastUsedAt: null,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function mgmtKeyDoc(over: Partial<ManagementApiKeyDoc> = {}): ManagementApiKeyDoc {
  return {
    _id: new ObjectId(MGMT_KEY_ID),
    organizationId: new ObjectId(ORG_ID),
    name: "management key",
    prefix: "tp_mgmt_prefix000001",
    keyHash: "hash",
    scopes: ["balances:read"],
    status: "active",
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function activeCustomer(): CustomerDoc {
  return {
    _id: new ObjectId(CUSTOMER_ID),
    organizationId: new ObjectId(ORG_ID),
    externalId: null,
    name: "Acme",
    email: null,
    balance: { amountMicros: 0, reservedMicros: 0, currency: "USD" },
    status: "active",
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function dupError(): PersistenceDuplicateKeyError {
  return new PersistenceDuplicateKeyError({
    code: "persistence_duplicate_key",
    message: "dup",
    retryClass: "never",
  });
}

async function run<E, A>(
  program: Effect.Effect<A, E, never>,
): Promise<{ tag: "Right"; value: A } | { tag: "Left"; error: E }> {
  const exit = await Effect.runPromiseExit(program);
  if (exit._tag === "Success") {
    return { tag: "Right", value: exit.value };
  }
  return { tag: "Left", error: Cause.squash(exit.cause) as E };
}

type InsertOutcome = "ok" | "dup";
type InsertLog = {
  readonly kind: "customer" | "management";
  readonly record: NewCustomerKeyRecord | NewManagementKeyRecord;
};

function keyStore(opts?: {
  readonly customerOutcomes?: readonly InsertOutcome[];
  readonly managementOutcomes?: readonly InsertOutcome[];
}) {
  const inserts: InsertLog[] = [];
  let customerCursor = 0;
  let managementCursor = 0;
  const customerOutcomes = opts?.customerOutcomes ?? ["ok"];
  const managementOutcomes = opts?.managementOutcomes ?? ["ok"];
  const next = (outcomes: readonly InsertOutcome[], cursor: number): InsertOutcome =>
    outcomes[Math.min(cursor, outcomes.length - 1)] ?? "ok";

  const service: KeyRepositoryService = {
    listCustomerKeys: neverCall,
    findCustomerKey: neverCall,
    findCustomerKeyByPrefix: neverCall,
    insertCustomerKey: (record) =>
      Effect.suspend(() => {
        inserts.push({ kind: "customer", record });
        if (next(customerOutcomes, customerCursor) === "dup") {
          customerCursor++;
          return Effect.fail(dupError());
        }
        customerCursor++;
        return Effect.succeed(
          apiKeyDoc({
            prefix: record.prefix,
            keyHash: record.keyHash,
            name: record.name,
            modelWhitelist: [...record.modelWhitelist],
          }),
        );
      }),
    updateCustomerKey: neverCall,
    revokeCustomerKey: neverCall,
    touchCustomerKeyLastUsed: neverCall,
    listManagementKeys: neverCall,
    findManagementKey: neverCall,
    findManagementKeyByPrefix: neverCall,
    insertManagementKey: (record) =>
      Effect.suspend(() => {
        inserts.push({ kind: "management", record });
        if (next(managementOutcomes, managementCursor) === "dup") {
          managementCursor++;
          return Effect.fail(dupError());
        }
        managementCursor++;
        return Effect.succeed(
          mgmtKeyDoc({
            prefix: record.prefix,
            keyHash: record.keyHash,
            name: record.name,
            scopes: [...record.scopes],
          }),
        );
      }),
    updateManagementKey: neverCall,
    revokeManagementKey: neverCall,
    touchManagementKeyLastUsed: neverCall,
    deleteManagementKeysByOrg: neverCall,
  };
  return { inserts, layer: Layer.succeed(KeyRepository, service) };
}

const customersLayer = Layer.succeed(CustomerRepository, {
  findById: (organizationId: string, customerId: string) =>
    Effect.succeed(
      organizationId === ORG_ID && customerId === CUSTOMER_ID
        ? activeCustomer()
        : null,
    ),
} as unknown as CustomerRepositoryService);

test("issueCustomerApiKey: fullKey hash matches stored record; strip applied", async () => {
  const store = keyStore();
  const result = await run(
    issueCustomerApiKey({
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      name: "prod key",
    }).pipe(Effect.provide(Layer.mergeAll(store.layer, customersLayer, CryptoTest))),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.key.startsWith("tp_live_")).toBe(true);
  expect(result.value.key.length).toBe(56);
  expect(result.value.apiKey.hasKey).toBe(true);
  expect("keyHash" in result.value.apiKey).toBe(false);
  const rec = store.inserts[0]?.record as NewCustomerKeyRecord | undefined;
  expect(rec).toBeDefined();
  if (!rec) return;
  expect(rec.keyHash).toBe(await hashToken(result.value.key));
  expect(rec.prefix).toBe(result.value.key.slice(0, 16));
  expect(rec.status).toBe("active");
});

test("issueCustomerApiKey: unknown customer → NotFoundError, no insert", async () => {
  const store = keyStore();
  const result = await run(
    issueCustomerApiKey({
      organizationId: ORG_ID,
      customerId: new ObjectId().toHexString(),
      name: "prod key",
    }).pipe(Effect.provide(Layer.mergeAll(store.layer, customersLayer, CryptoTest))),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("NotFoundError");
  if (result.error._tag !== "NotFoundError") {
    throw new Error("expected NotFoundError");
  }
  expect(result.error.code).toBe("customer_not_found");
  expect(result.error.resource).toBe("customer");
  expect(store.inserts).toHaveLength(0);
});

test("issueCustomerApiKey: duplicate prefix retried until insert succeeds", async () => {
  const store = keyStore({ customerOutcomes: ["dup", "dup", "ok"] });
  const result = await run(
    issueCustomerApiKey({
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      name: "prod key",
    }).pipe(Effect.provide(Layer.mergeAll(store.layer, customersLayer, CryptoTest))),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(store.inserts).toHaveLength(3);
  const prefixes = store.inserts.map(
    (i) => (i.record as NewCustomerKeyRecord).prefix,
  );
  expect(new Set(prefixes).size).toBe(3);
});

test("issueCustomerApiKey: exhausted collisions → SystemError prefix_collision", async () => {
  const store = keyStore({
    customerOutcomes: ["dup", "dup", "dup", "dup", "dup"],
  });
  const result = await run(
    issueCustomerApiKey({
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      name: "prod key",
    }).pipe(Effect.provide(Layer.mergeAll(store.layer, customersLayer, CryptoTest))),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("SystemError");
  expect(result.error.code).toBe("system_error");
  expect(result.error.message).toBe("prefix_collision");
  expect(store.inserts.length).toBeGreaterThanOrEqual(2);
});

test("issueCustomerApiKey: non-duplicate repo error propagates untouched", async () => {
  const unavailable = Layer.succeed(KeyRepository, {
    insertCustomerKey: () => Effect.fail(dupUnavailable()),
    ...neverCallKeySurface(),
  } as unknown as KeyRepositoryService);
  const result = await run(
    issueCustomerApiKey({
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      name: "prod key",
    }).pipe(Effect.provide(Layer.mergeAll(unavailable, customersLayer, CryptoTest))),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("PersistenceUnavailableError");
});

function dupUnavailable(): PersistenceUnavailableError {
  return new PersistenceUnavailableError({
    code: "persistence_unavailable",
    message: "down",
    retryClass: "transient",
  });
}

function neverCallKeySurface(): Partial<KeyRepositoryService> {
  return {
    listCustomerKeys: neverCall,
    findCustomerKey: neverCall,
    findCustomerKeyByPrefix: neverCall,
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
    deleteManagementKeysByOrg: neverCall,
  };
}

test("issueManagementKey: admin grants scope; key hash verified against record", async () => {
  const store = keyStore();
  const result = await run(
    issueManagementKey({
      organizationId: ORG_ID,
      name: "ops key",
      scopes: ["balances:read"],
      actorRole: "admin",
      actorPermissions: [],
    }).pipe(Effect.provide(Layer.mergeAll(store.layer, CryptoTest))),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.key.startsWith("tp_mgmt_")).toBe(true);
  expect(result.value.managementKey.scopes).toEqual(["balances:read"]);
  const rec = store.inserts[0]?.record as NewManagementKeyRecord | undefined;
  expect(rec?.keyHash).toBe(await hashToken(result.value.key));
});

test("issueManagementKey: member granting unheld scope → privilege_escalation", async () => {
  const store = keyStore();
  const result = await run(
    issueManagementKey({
      organizationId: ORG_ID,
      name: "ops key",
      scopes: ["balances:read"],
      actorRole: "member",
      actorPermissions: [],
    }).pipe(Effect.provide(Layer.mergeAll(store.layer, CryptoTest))),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthorizationError");
  if (result.error._tag !== "AuthorizationError") {
    throw new Error("expected AuthorizationError");
  }
  expect(result.error.reason).toBe("privilege_escalation");
  expect(store.inserts).toHaveLength(0);
});

test("updateCustomerApiKey: strips hash on success; null → api_key not_found", async () => {
  const keys = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    updateCustomerKey: () => Effect.succeed(apiKeyDoc({ name: "renamed" })),
  } as unknown as KeyRepositoryService);
  const ok = await run(
    updateCustomerApiKey({
      organizationId: ORG_ID,
      keyId: KEY_ID,
      patch: { name: "renamed" },
    }).pipe(Effect.provide(keys)),
  );
  expect(ok.tag).toBe("Right");
  if (ok.tag === "Right") {
    expect(ok.value.name).toBe("renamed");
    expect("keyHash" in ok.value).toBe(false);
  }
  const missing = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    updateCustomerKey: () => Effect.succeed(null),
  } as unknown as KeyRepositoryService);
  const bad = await run(
    updateCustomerApiKey({
      organizationId: ORG_ID,
      keyId: KEY_ID,
      patch: { name: "renamed" },
    }).pipe(Effect.provide(missing)),
  );
  expect(bad.tag).toBe("Left");
  if (bad.tag !== "Left") return;
  if (bad.error._tag !== "NotFoundError") {
    throw new Error("expected NotFoundError");
  }
  expect(bad.error.code).toBe("not_found");
  expect(bad.error.resource).toBe("api_key");
});

test("revokeCustomerApiKey: returns final status; null → not_found", async () => {
  const keys = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    revokeCustomerKey: () => Effect.succeed(apiKeyDoc({ status: "revoked" })),
  } as unknown as KeyRepositoryService);
  const ok = await run(
    revokeCustomerApiKey({ organizationId: ORG_ID, keyId: KEY_ID }).pipe(
      Effect.provide(keys),
    ),
  );
  expect(ok.tag).toBe("Right");
  if (ok.tag === "Right") expect(ok.value.status).toBe("revoked");
});

test("listCustomerApiKeys: strips keyHash from every page item", async () => {
  const keys = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    listCustomerKeys: () =>
      Effect.succeed({ items: [apiKeyDoc(), apiKeyDoc()], total: 2 }),
  } as unknown as KeyRepositoryService);
  const result = await run(
    listCustomerApiKeys({ organizationId: ORG_ID }).pipe(Effect.provide(keys)),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.total).toBe(2);
  for (const item of result.value.items) {
    expect("keyHash" in item).toBe(false);
    expect(item.hasKey).toBe(true);
  }
});

test("listManagementKeys: forwards status filter, strips keyHash", async () => {
  const seen: (string | undefined)[] = [];
  const keys = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    listManagementKeys: (_orgId: string, status?: "active" | "revoked") => {
      seen.push(status);
      return Effect.succeed([mgmtKeyDoc()]);
    },
  } as unknown as KeyRepositoryService);
  const result = await run(
    listManagementKeys({ organizationId: ORG_ID, status: "active" }).pipe(
      Effect.provide(keys),
    ),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value[0]?.hasKey).toBe(true);
  expect(seen).toEqual(["active"]);
});

test("updateManagementKey: admin patch dedupes + sorts final scopes", async () => {
  const keys = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    findManagementKey: () => Effect.succeed(mgmtKeyDoc({ scopes: ["models:read"] })),
    updateManagementKey: (_org: string, _key: string, patch: Record<string, unknown>) =>
      Effect.succeed(
        mgmtKeyDoc({ ...(patch as Partial<ManagementApiKeyDoc>) }),
      ),
  } as unknown as KeyRepositoryService);
  const result = await run(
    updateManagementKey({
      organizationId: ORG_ID,
      keyId: MGMT_KEY_ID,
      patch: {
        name: "renamed",
        scopes: ["balances:read", "balances:read", "models:read"],
      },
      actorRole: "admin",
      actorPermissions: [],
    }).pipe(Effect.provide(keys)),
  );
  expect(result.tag).toBe("Right");
  if (result.tag !== "Right") return;
  expect(result.value.scopes).toEqual(["balances:read", "models:read"]);
});

test("updateManagementKey: member adding unheld scope fails before update", async () => {
  const updates: string[] = [];
  const keys = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    findManagementKey: () => Effect.succeed(mgmtKeyDoc({ scopes: ["models:read"] })),
    updateManagementKey: () =>
      Effect.sync(() => {
        updates.push("update");
        return mgmtKeyDoc();
      }),
  } as unknown as KeyRepositoryService);
  const result = await run(
    updateManagementKey({
      organizationId: ORG_ID,
      keyId: MGMT_KEY_ID,
      patch: { scopes: ["balances:read", "models:read"] },
      actorRole: "member",
      actorPermissions: [],
    }).pipe(Effect.provide(keys)),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  expect(result.error._tag).toBe("AuthorizationError");
  if (result.error._tag !== "AuthorizationError") {
    throw new Error("expected AuthorizationError");
  }
  expect(result.error.reason).toBe("privilege_escalation");
  expect(updates).toHaveLength(0);
});

test("updateManagementKey: unknown key → management_key not_found", async () => {
  const keys = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    findManagementKey: () => Effect.succeed(null),
  } as unknown as KeyRepositoryService);
  const result = await run(
    updateManagementKey({
      organizationId: ORG_ID,
      keyId: MGMT_KEY_ID,
      patch: { name: "x" },
      actorRole: "admin",
      actorPermissions: [],
    }).pipe(Effect.provide(keys)),
  );
  expect(result.tag).toBe("Left");
  if (result.tag !== "Left") return;
  if (result.error._tag !== "NotFoundError") {
    throw new Error("expected NotFoundError");
  }
  expect(result.error.resource).toBe("management_key");
});

test("revokeManagementKey: ok status; null → management_key not_found", async () => {
  const keys = Layer.succeed(KeyRepository, {
    ...neverCallKeySurface(),
    revokeManagementKey: () => Effect.succeed(mgmtKeyDoc({ status: "revoked" })),
  } as unknown as KeyRepositoryService);
  const ok = await run(
    revokeManagementKey({ organizationId: ORG_ID, keyId: MGMT_KEY_ID }).pipe(
      Effect.provide(keys),
    ),
  );
  expect(ok.tag).toBe("Right");
  if (ok.tag === "Right") expect(ok.value.status).toBe("revoked");
});

test("strip helpers drop keyHash and flag hasKey", () => {
  const s1 = stripCustomerKey(apiKeyDoc());
  expect("keyHash" in s1).toBe(false);
  expect(s1.hasKey).toBe(true);
  const s2 = stripManagementKey(mgmtKeyDoc());
  expect("keyHash" in s2).toBe(false);
  expect(s2.hasKey).toBe(true);
});
