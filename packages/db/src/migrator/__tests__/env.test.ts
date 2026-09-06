import { test, expect, describe } from "bun:test";
import { parseMigratorEnv } from "../env.ts";

describe("parseMigratorEnv", () => {
  test("parses uri + databaseName from env", () => {
    const config = parseMigratorEnv({
      MONGODB_URI: "mongodb://localhost:27017",
      MONGODB_DB: "tokenpanel_migrate",
    });
    expect(config).toEqual({
      uri: "mongodb://localhost:27017",
      databaseName: "tokenpanel_migrate",
    });
  });

  test("defaults databaseName to 'tokenpanel' when MONGODB_DB is unset", () => {
    const config = parseMigratorEnv({ MONGODB_URI: "mongodb+srv://cluster.example.com" });
    expect(config.databaseName).toBe("tokenpanel");
  });

  test("empty MONGODB_DB also falls back to 'tokenpanel'", () => {
    const config = parseMigratorEnv({
      MONGODB_URI: "mongodb://localhost:27017",
      MONGODB_DB: "",
    });
    expect(config.databaseName).toBe("tokenpanel");
  });

  test("missing MONGODB_URI is rejected", () => {
    expect(() => parseMigratorEnv({})).toThrow(/MONGODB_URI not set/);
    expect(() => parseMigratorEnv({ MONGODB_URI: "" })).toThrow(/MONGODB_URI not set/);
  });

  test("non-mongodb scheme is rejected (http, postgres, bare host)", () => {
    expect(() =>
      parseMigratorEnv({ MONGODB_URI: "http://localhost:27017" }),
    ).toThrow(/must start with mongodb:\/\//);
    expect(() =>
      parseMigratorEnv({ MONGODB_URI: "postgres://localhost:5432" }),
    ).toThrow(/must start with mongodb:\/\//);
    expect(() =>
      parseMigratorEnv({ MONGODB_URI: "localhost:27017" }),
    ).toThrow(/must start with mongodb:\/\//);
  });

  test("both mongodb:// and mongodb+srv:// schemes are accepted", () => {
    expect(
      parseMigratorEnv({ MONGODB_URI: "mongodb://h:27017" }).uri,
    ).toBe("mongodb://h:27017");
    expect(
      parseMigratorEnv({ MONGODB_URI: "mongodb+srv://cluster.example.com" }).uri,
    ).toBe("mongodb+srv://cluster.example.com");
  });
});
