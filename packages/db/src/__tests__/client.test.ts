import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  getMongoUri,
  getDbName,
  configureDb,
  clearDbConfig,
  closeDb,
  getMongoConnectionConfig,
  isDbConfigured,
} from "../client.ts";

/** Integration suites may leave a live client + configureDb config on the module. */
async function resetDbConfigState(): Promise<void> {
  await closeDb().catch(() => undefined);
  clearDbConfig();
}

beforeEach(async () => {
  await resetDbConfigState();
});

afterEach(async () => {
  await resetDbConfigState();
});

test("getMongoUri throws when neither configureDb nor MONGODB_URI", () => {
  const prev = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    expect(() => getMongoUri()).toThrow(/MONGODB_URI|configureDb/);
  } finally {
    if (prev !== undefined) process.env.MONGODB_URI = prev;
  }
});

test("getMongoUri returns env value when set (legacy path)", () => {
  const prev = process.env.MONGODB_URI;
  process.env.MONGODB_URI = "mongodb://localhost:27017";
  try {
    expect(getMongoUri()).toBe("mongodb://localhost:27017");
  } finally {
    if (prev !== undefined) process.env.MONGODB_URI = prev;
    else delete process.env.MONGODB_URI;
  }
});

test("getDbName defaults to 'tokenpanel' when env unset (legacy path)", () => {
  const prev = process.env.MONGODB_DB;
  delete process.env.MONGODB_DB;
  try {
    expect(getDbName()).toBe("tokenpanel");
  } finally {
    if (prev !== undefined) process.env.MONGODB_DB = prev;
  }
});

test("getDbName returns env override (legacy path)", () => {
  const prev = process.env.MONGODB_DB;
  process.env.MONGODB_DB = "custom-db";
  try {
    expect(getDbName()).toBe("custom-db");
  } finally {
    if (prev !== undefined) process.env.MONGODB_DB = prev;
    else delete process.env.MONGODB_DB;
  }
});

test("configureDb + getMongoConnectionConfig is the preferred path", () => {
  configureDb({
    uri: "mongodb://example:27017",
    databaseName: "tp",
  });
  expect(isDbConfigured()).toBe(true);
  expect(getMongoConnectionConfig()).toEqual({
    uri: "mongodb://example:27017",
    databaseName: "tp",
  });
  expect(getMongoUri()).toBe("mongodb://example:27017");
  expect(getDbName()).toBe("tp");
});
