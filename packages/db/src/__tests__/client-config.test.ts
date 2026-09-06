import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  configureDb,
  clearDbConfig,
  isDbConfigured,
  getMongoConnectionConfig,
  getDb,
  getClient,
  getRawDb,
  closeDb,
} from "../client.ts";
import {
  startTestDb,
  stopTestDb,
  TEST_DB_START_TIMEOUT_MS,
  type TestDbHandle,
} from "../test-support/memory-server.ts";

/**
 * configureDb / getMongoConnectionConfig / isDbConfigured / clearDbConfig
 * state machine plus the client.ts connect/cache/close behavior.
 *
 * bun:test runs this file's tests in declaration order: connection-backed
 * assertions run first (harness client live), then the env-fallback path,
 * then the pure config state machine. Every test leaves the module
 * disconnected and unconfigured (finally blocks + afterAll), so the module
 * state machine is exercised in a defined order.
 */

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await startTestDb({ databaseName: "client_config_test" });
}, TEST_DB_START_TIMEOUT_MS);

afterAll(async () => {
  // Reset the client module state regardless of how tests above ended,
  // then tear the harness down for the next suite in this process.
  await closeDb().catch(() => undefined);
  clearDbConfig();
  await stopTestDb();
});

// --- While the harness connection is live ----------------------------------

test("configureDb is refused while a connection is established", () => {
  expect(() =>
    configureDb({ uri: "mongodb://other:27017", databaseName: "other" }),
  ).toThrow(/configureDb refused.*closeDb/);
  // The refusal left the live configuration untouched.
  expect(getMongoConnectionConfig().databaseName).toBe("client_config_test");
});

test("clearDbConfig is refused while a connection is established", () => {
  expect(() => clearDbConfig()).toThrow(/clearDbConfig refused while connected/);
  expect(isDbConfigured()).toBe(true);
});

test("getDb caches identity and getClient/getRawDb expose the same connection", async () => {
  const db = await getDb();
  expect(await getDb()).toBe(db);
  expect(getClient()).toBe(handle.client);
  expect(getRawDb()).toBe(handle.rawDb);
  expect(getRawDb().databaseName).toBe("client_config_test");
});

test("closeDb disconnects, keeps the config, and is idempotent", async () => {
  await closeDb();
  expect(() => getClient()).toThrow(/MongoDB not connected/);
  expect(() => getRawDb()).toThrow(/MongoDB not connected/);
  // closeDb resets the connection but NOT the configuration.
  expect(isDbConfigured()).toBe(true);
  expect(getMongoConnectionConfig().databaseName).toBe("client_config_test");
  // Double close: no client anymore, still no throw.
  await expect(closeDb()).resolves.toBeUndefined();
  // A fresh getDb() reuses the kept config (not env, not a new client per call).
  const db = await getDb();
  expect(await getDb()).toBe(db);
  expect(getRawDb().databaseName).toBe("client_config_test");
});

// --- Env fallback (library unconfigured) ------------------------------------

test("getDb throws when neither configureDb nor MONGODB_URI is available", async () => {
  await closeDb().catch(() => undefined);
  clearDbConfig();
  const prev = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    expect(isDbConfigured()).toBe(false);
    await expect(getDb()).rejects.toThrow(/MongoDB not configured/);
    // The failed attempt must not have configured anything.
    expect(isDbConfigured()).toBe(false);
  } finally {
    if (prev !== undefined) process.env.MONGODB_URI = prev;
  }
});

test("getDb falls back to MONGODB_URI/MONGODB_DB env when unconfigured", async () => {
  await closeDb().catch(() => undefined);
  clearDbConfig();
  const prevUri = process.env.MONGODB_URI;
  const prevDb = process.env.MONGODB_DB;
  process.env.MONGODB_URI = handle.uri;
  process.env.MONGODB_DB = "client_env_fallback";
  try {
    expect(isDbConfigured()).toBe(false);
    const db = await getDb();
    // The fallback configured the library from env...
    expect(getMongoConnectionConfig()).toEqual({
      uri: handle.uri,
      databaseName: "client_env_fallback",
    });
    expect(isDbConfigured()).toBe(true);
    // ...selected the env database name...
    expect(getRawDb().databaseName).toBe("client_env_fallback");
    // ...and actually reached the server.
    const ping = await getRawDb().command({ ping: 1 });
    expect(ping.ok).toBe(1);
    expect(await getDb()).toBe(db);
  } finally {
    await closeDb().catch(() => undefined);
    if (prevUri !== undefined) process.env.MONGODB_URI = prevUri;
    else delete process.env.MONGODB_URI;
    if (prevDb !== undefined) process.env.MONGODB_DB = prevDb;
    else delete process.env.MONGODB_DB;
    clearDbConfig();
  }
});

// --- Pure config state machine (no connection) -------------------------------

test("getMongoConnectionConfig throws when nothing is configured", () => {
  clearDbConfig();
  expect(() => getMongoConnectionConfig()).toThrow(/MongoDB not configured/);
  expect(isDbConfigured()).toBe(false);
});

test("configureDb rejects empty uri, whitespace-only uri, and empty databaseName", () => {
  try {
    expect(() => configureDb({ uri: "", databaseName: "db" })).toThrow(/uri is required/);
    expect(() => configureDb({ uri: "   ", databaseName: "db" })).toThrow(/uri is required/);
    expect(() => configureDb({ uri: "mongodb://h:27017", databaseName: "" })).toThrow(
      /databaseName is required/,
    );
    // None of the rejected calls left a configuration behind.
    expect(isDbConfigured()).toBe(false);
  } finally {
    clearDbConfig();
  }
});

test("configureDb stores a frozen config that getMongoConnectionConfig returns", () => {
  try {
    configureDb({ uri: "mongodb://example:27017", databaseName: "state_machine" });
    expect(isDbConfigured()).toBe(true);
    const config = getMongoConnectionConfig();
    expect(config).toEqual({
      uri: "mongodb://example:27017",
      databaseName: "state_machine",
    });
    expect(Object.isFrozen(config)).toBe(true);
  } finally {
    clearDbConfig();
  }
});

test("clearDbConfig makes the library unconfigured again", () => {
  configureDb({ uri: "mongodb://example:27017", databaseName: "state_machine" });
  expect(isDbConfigured()).toBe(true);
  clearDbConfig();
  expect(isDbConfigured()).toBe(false);
  expect(() => getMongoConnectionConfig()).toThrow(/MongoDB not configured/);
});
