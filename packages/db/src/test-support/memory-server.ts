/**
 * In-memory MongoDB test harness (mongodb-memory-server).
 *
 * - The mongod binary is pinned to the same major.minor as the `mongo:` image
 *   in `compose.yml` (mongo:8 currently resolves to 8.3.8) and is downloaded
 *   to `~/.cache/mongodb-binary` on first use. CI should cache that directory
 *   between runs; set `MONGOMS_VERSION` to override the pin locally.
 * - The server runs as a single-node replica set (WiredTiger storage) so that
 *   multi-document transactions — required by db consumers — work, mirroring
 *   the compose setup (`--replSet rs0`).
 * - The harness is a per-process singleton: `bun test` runs every test file of
 *   one `bun test` invocation in a single process, so all suites share one
 *   mongod + one configured `@tokenpanel/db` client. Different packages/tests
 *   run in separate processes, each with their own singleton, which is the
 *   correct granularity because `configureDb` refuses reconfiguration while
 *   connected.
 * - `@tokenpanel/db` intentionally does not rely on mongodb-memory-server's
 *   postinstall download; the binary is fetched lazily on first
 *   `startTestDb()` call (or override with `MONGOMS_DISABLE_POSTINSTALL=1`,
 *   which is the package default expectation).
 */

import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { MongoClient, Db } from "mongodb";
import { configureDb, closeDb, getDb, getRawDb, getClient } from "../client.ts";
import type { TypedDb } from "../schemas/index.ts";
import {
  apiKeyFixture,
  customerFixture,
  modelCatalogFixture,
  modelFixture,
  organizationFixture,
  providerFixture,
  userFixture,
} from "./persistence-fixtures.ts";

import { createRequire } from "node:module";
import { existsSync } from "node:fs";

/**
 * Bun compat shim for hosts with IPv6 disabled (e.g. some WSL2 setups).
 * Bun's `node:net` shim (<= 1.4.x) fails with "Failed to listen at ::" when
 * `server.listen(port)` is called without an explicit host, while Node falls
 * back to `0.0.0.0` (EAFNOSUPPORT). mongodb-memory-server's port probe calls
 * exactly that form, so redirect it to an IPv4 wildcard — only when the
 * kernel actually lacks IPv6, keeping every other environment untouched.
 */
// Executed at module load (NOT inside a wrapped function): Bun deoptimizes a
// prototype patch installed from inside a closure and the patch silently
// never sticks; a top-level `if` block is reliable.
if (existsSync("/proc/net/if_inet6") === false) {
  const req = createRequire(import.meta.url);
  const net = req("node:net") as {
    Server: { prototype: { listen: (...args: unknown[]) => unknown } };
  };
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (
    this: { listen: (...args: unknown[]) => unknown },
    ...args: unknown[]
  ) {
    // Host-less form: `listen(port[, callback])` — supply the IPv4 wildcard.
    if (typeof args[0] === "number" && typeof args[1] !== "string") {
      return originalListen.call(this, args[0] as number, "0.0.0.0", ...args.slice(1));
    }
    return originalListen.apply(this, args);
  } as typeof originalListen;
}

/** Default database used by the shared test server. */
const DEFAULT_TEST_DB_NAME = "tokenpanel_test";

/**
 * Generous startup budget: the very first call on a machine downloads the
 * pinned mongod binary (~100 MB). CI should cache `~/.cache/mongodb-binary`.
 */
export const TEST_DB_START_TIMEOUT_MS = 300_000;

/** Pinned mongod version — same major.minor as the `mongo:8` image in compose.yml. */
const MONGO_BINARY_VERSION = "8.3.8";

export type TestDbHandle = Readonly<{
  uri: string;
  databaseName: string;
  /** Typed accessor from getDb() — the process-global singleton. */
  db: TypedDb;
  /** Raw Db handle from getRawDb() — for assertions and migrations. */
  rawDb: Db;
  /** Raw MongoClient from getClient() — for sessions/transactions. */
  client: MongoClient;
}>;

/**
 * Ids of the documents inserted by seedBasicDataset (FIXTURE_IDS values).
 */
export type SeededIds = Readonly<{
  organizationId: string;
  userId: string;
  customerId: string;
  providerId: string;
  modelCatalogId: string;
  modelId: string;
  apiKeyId: string;
}>;

type StartOptions = Readonly<{ databaseName?: string }>;

let replSet: MongoMemoryReplSet | null = null;
let externalUri: string | null = null;
let handle: TestDbHandle | null = null;
let exitHookInstalled = false;

function getExternalUri(): string | null {
  const external = process.env.TEST_MONGODB_URI;
  return external !== undefined && external.trim().length > 0 ? external : null;
}

function readExternalUri(): string | null {
  if (externalUri === null) externalUri = getExternalUri();
  return externalUri;
}


/** Best-effort safety net so a crashed suite does not leak a mongod child. */
function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (replSet) {
      try {
        replSet.stop({ doCleanup: false });
      } catch {
        // Best-effort: "exit" handlers must stay synchronous and silent.
      }
    }
  });
}

/**
 * Start (or reuse) the shared test database.
 *
 * Memoized per process: repeated calls with the same `databaseName` return the
 * existing handle; a different name is a configuration error because
 * `configureDb` supports only one database per process. When
 * `TEST_MONGODB_URI` is set, the memory server is skipped entirely and that
 * URI is used instead (debugging against the real compose Mongo) with the
 * same singleton semantics.
 */
export async function startTestDb(options?: StartOptions): Promise<TestDbHandle> {
  const databaseName = options?.databaseName ?? DEFAULT_TEST_DB_NAME;

  if (handle) {
    if (handle.databaseName !== databaseName) {
      throw new Error(
        `startTestDb: this process is already bound to database "${handle.databaseName}"; ` +
          `refusing to reconfigure to "${databaseName}" (one test DB per process).`,
      );
    }
    return handle;
  }

  const external = readExternalUri();
  if (external) {
    // Escape hatch: reuse a real (e.g. compose) Mongo instead of the memory
    // server. Same singleton semantics; stopTestDb skips server teardown.
    configureDb({ uri: external, databaseName });
  } else {
    if (!replSet) {
      ensureExitHook();
      replSet = await MongoMemoryReplSet.create({
        binary: { version: MONGO_BINARY_VERSION },
        replSet: {
          count: 1,
          storageEngine: "wiredTiger",
          // Seed the default dbName into generated URIs; configureDb still
          // controls which database the client actually selects.
          dbName: databaseName,
        },
      });
    }
    configureDb({ uri: replSet.getUri(), databaseName });
  }
  const db = await getDb();
  handle = Object.freeze({
    uri: external ?? (replSet ? replSet.getUri() : ""),
    databaseName,
    db,
    rawDb: getRawDb(),
    client: getClient(),
  });
  return handle;
}

/**
 * Close the db client and stop the memory server (unless backed by an
 * external `TEST_MONGODB_URI`). Safe to call when nothing is started (no-op);
 * afterwards the singleton resets and `startTestDb` can start fresh.
 */
export async function stopTestDb(): Promise<void> {
  handle = null;
  await closeDb();
  if (replSet) {
    const set = replSet;
    replSet = null;
    await set.stop();
  }
}

/**
 * Delete all documents from the named collections of the shared test DB.
 * Names are compile-time constrained to real `TypedDb` collection keys.
 */
export async function resetTestCollections(
  ...names: ReadonlyArray<keyof TypedDb & string>
): Promise<void> {
  if (!handle) {
    throw new Error(
      "resetTestCollections: test DB not started. Call startTestDb() first.",
    );
  }
  for (const name of names) {
    await handle.db[name].deleteMany({});
  }
}

/**
 * Insert one canonical dataset using the shared persistence fixtures:
 * organization, admin user, customer (nonzero balance), provider, model
 * catalog entry + model, and a customer API key. Idempotency is intentionally
 * not guaranteed; suites reset collections first when they need a clean slate.
 */
export async function seedBasicDataset(): Promise<SeededIds> {
  if (!handle) {
    throw new Error(
      "seedBasicDataset: test DB not started. Call startTestDb() first.",
    );
  }
  const db = handle.db;

  const organization = organizationFixture();
  const user = userFixture();
  const customer = customerFixture();
  const provider = providerFixture();
  const modelCatalog = modelCatalogFixture();
  const model = modelFixture();
  const apiKey = apiKeyFixture();

  await db.organizations.insertOne(organization);
  await db.users.insertOne(user);
  await db.customers.insertOne(customer);
  await db.providers.insertOne(provider);
  await db.modelCatalog.insertOne(modelCatalog);
  await db.models.insertOne(model);
  await db.apiKeys.insertOne(apiKey);

  return Object.freeze({
    organizationId: organization._id.toString(),
    userId: user._id.toString(),
    customerId: customer._id.toString(),
    providerId: provider._id.toString(),
    modelCatalogId: modelCatalog._id.toString(),
    modelId: model._id.toString(),
    apiKeyId: apiKey._id.toString(),
  });
}
