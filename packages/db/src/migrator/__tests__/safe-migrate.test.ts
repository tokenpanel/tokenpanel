import { lintMigration } from "../safe-migrate.ts";
import { test, expect } from "bun:test";

test("lintMigration: allows additive operations in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").createIndex({ foo: 1 }, { session });
      await db.collection("test").insertOne({ foo: "bar" }, { session });
      await db.collection("test").updateMany({}, { $set: { status: "active" } }, { session });
    }
  `;
  expect(lintMigration(content)).toEqual([]);
});

test("lintMigration: rejects .drop() in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").drop();
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes(".drop()"))).toBe(true);
});

test("lintMigration: rejects .dropIndex() in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").dropIndex("foo_1");
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("dropIndex"))).toBe(true);
});

test("lintMigration: rejects $unset in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").updateMany({}, { $unset: { legacy: "" } }, { session });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("$unset"))).toBe(true);
});

test("lintMigration: rejects $rename in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").updateMany({}, { $rename: { old: "new" } }, { session });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("$rename"))).toBe(true);
});

test("lintMigration: rejects collMod in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").createIndex({ foo: 1 }, { session });
      await db.command({ collMod: "test", validator: {} });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("collMod"))).toBe(true);
});

test("lintMigration: rejects .deleteMany() in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").deleteMany({}, { session });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("deleteMany"))).toBe(true);
});

test("lintMigration: rejects .deleteOne() in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").deleteOne({ foo: "bar" }, { session });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("deleteOne"))).toBe(true);
});

test("lintMigration: rejects .findOneAndDelete() in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").findOneAndDelete({ foo: "bar" }, { session });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("findOneAndDelete"))).toBe(true);
});

test("lintMigration: rejects bulkWrite delete operations in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").bulkWrite([
        { deleteOne: { filter: { foo: "bar" } } },
        { deleteMany: { filter: { baz: 1 } } },
      ], { session });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("deleteOne"))).toBe(true);
  expect(v.some((s) => s.includes("deleteMany"))).toBe(true);
});

test("lintMigration: allows bulkWrite with only upserts/updates in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").bulkWrite([
        { insertOne: { document: { foo: "bar" } } },
        { updateOne: { filter: { foo: "bar" }, update: { $set: { a: 1 } }, upsert: true } },
      ], { session });
    }
  `;
  expect(lintMigration(content)).toEqual([]);
});

test("lintMigration: rejects db.command({ drop: ... }) in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.command({ drop: "test_coll" });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("drop")) || v.some((s) => s.includes("not in safe allowlist"))).toBe(true);
});

test("lintMigration: rejects db.command({ dropDatabase: 1 }) in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.command({ dropDatabase: 1 });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("dropDatabase")) || v.some((s) => s.includes("not in safe allowlist"))).toBe(true);
});

test("lintMigration: rejects db.command({ renameCollection: ... }) in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.command({ renameCollection: "a", to: "b" });
    }
  `;
  const v = lintMigration(content);
  expect(v.length).toBeGreaterThan(0);
  expect(v.some((s) => s.includes("renameCollection")) || v.some((s) => s.includes("not in safe allowlist"))).toBe(true);
});

test("lintMigration: allows db.command({ createIndexes: ... }) in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.command({ createIndexes: "test", indexes: [{ key: { foo: 1 }, name: "foo_1" }] });
    }
  `;
  expect(lintMigration(content)).toEqual([]);
});

test("lintMigration: allows db.command({ ping: 1 }) in pre/", () => {
  const content = `
    export async function up(db, session) {
      await db.command({ ping: 1 });
    }
  `;
  expect(lintMigration(content)).toEqual([]);
});

test("lintMigration: rejects unknown db.command in pre/ (suspicious)", () => {
  const content = `
    export async function up(db, session) {
      await db.command({ ftxSync: 1 });
    }
  `;
  const v = lintMigration(content);
  expect(v.some((s) => s.includes("not in safe allowlist"))).toBe(true);
});

test("lintMigration: allows $setOnInsert (not in forbidden list)", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").insertOne({ foo: "bar" }, { session });
    }
  `;
  expect(lintMigration(content)).toEqual([]);
});

test("lintMigration: allows destructive ops in down() (only up is linted)", () => {
  const content = `
    export async function up(db, session) {
      await db.collection("test").createIndex({ foo: 1 }, { session });
    }

    export async function down(db, session) {
      await db.collection("test").dropIndex("foo_1");
      await db.collection("test").updateMany({}, { $unset: { foo: "" } });
    }
  `;
  expect(lintMigration(content)).toEqual([]);
});
