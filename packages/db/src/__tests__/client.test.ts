import { test, expect } from "bun:test";
import { getMongoUri, getDbName } from "../client.ts";

test("getMongoUri throws when MONGODB_URI unset", () => {
  const orig = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    expect(() => getMongoUri()).toThrow(/MONGODB_URI/);
  } finally {
    if (orig !== undefined) process.env.MONGODB_URI = orig;
  }
});

test("getMongoUri returns env value when set", () => {
  const orig = process.env.MONGODB_URI;
  process.env.MONGODB_URI = "mongodb://localhost:27017";
  try {
    expect(getMongoUri()).toBe("mongodb://localhost:27017");
  } finally {
    if (orig !== undefined) process.env.MONGODB_URI = orig;
    else delete process.env.MONGODB_URI;
  }
});

test("getDbName defaults to 'tokenpanel' when env unset", () => {
  const orig = process.env.MONGODB_DB;
  delete process.env.MONGODB_DB;
  try {
    expect(getDbName()).toBe("tokenpanel");
  } finally {
    if (orig !== undefined) process.env.MONGODB_DB = orig;
  }
});

test("getDbName returns env override", () => {
  const orig = process.env.MONGODB_DB;
  process.env.MONGODB_DB = "custom-db";
  try {
    expect(getDbName()).toBe("custom-db");
  } finally {
    if (orig !== undefined) process.env.MONGODB_DB = orig;
    else delete process.env.MONGODB_DB;
  }
});