import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { getMigrationStatus, isLegacyChecksumMismatch } from "../runner.ts";
import { loadMigrationTree } from "../validator.ts";
import type { MigrationFile } from "../types.ts";
import {
  startTestDb,
  stopTestDb,
  TEST_DB_START_TIMEOUT_MS,
  type TestDbHandle,
} from "../../test-support/memory-server.ts";

/**
 * getMigrationStatus against the in-memory MongoDB harness: pending/applied
 * accounting over the real committed migration tree, plus checksum-mismatch
 * flagging on both enforcement-era and pre-rollout (legacy) ids.
 */

const MIGRATIONS_COLLECTION = "_migrations";

interface MigrationDoc {
  _id: string;
  phase: string;
  appliedAt: Date;
  checksum: string;
}

let handle: TestDbHandle;
let allMigrations: MigrationFile[];

beforeAll(async () => {
  handle = await startTestDb({ databaseName: "migrator_status_test" });
  const tree = await loadMigrationTree();
  allMigrations = [...tree.pre, ...tree.post];
  expect(allMigrations.length).toBeGreaterThan(0);
}, TEST_DB_START_TIMEOUT_MS);

afterEach(async () => {
  await handle.rawDb.collection<MigrationDoc>(MIGRATIONS_COLLECTION).deleteMany({});
});

afterAll(() => stopTestDb());

function appliedRecord(m: MigrationFile, checksum: string): MigrationDoc {
  return { _id: m.id, phase: m.phase, appliedAt: new Date(), checksum };
}

test("empty _migrations tree: every committed migration is pending, no mismatches", async () => {
  const status = await getMigrationStatus(handle.rawDb);
  expect(status.applied).toBe(0);
  expect(status.pending).toBe(allMigrations.length);
  expect([...status.pendingIds].sort()).toEqual(
    allMigrations.map((m) => m.id).sort(),
  );
  expect(status.checksumMismatches).toEqual([]);
  expect(status.legacyChecksumMismatches).toEqual([]);
});

test("partially applied tree: applied/pending split matches the _migrations docs", async () => {
  const targets = allMigrations.slice(0, 2);
  const col = handle.rawDb.collection<MigrationDoc>(MIGRATIONS_COLLECTION);
  for (const m of targets) await col.insertOne(appliedRecord(m, m.checksum));
  // An applied doc whose id is no longer on disk still counts as applied.
  await col.insertOne({
    _id: "0000-00-00T00-00-00Z__removed-from-tree",
    phase: "pre",
    appliedAt: new Date(),
    checksum: "old",
  });

  const status = await getMigrationStatus(handle.rawDb);
  expect(status.applied).toBe(targets.length + 1);
  expect(status.pending).toBe(allMigrations.length - targets.length);
  const appliedIds = targets.map((m) => m.id);
  expect(status.pendingIds.some((id) => appliedIds.includes(id))).toBe(false);
  expect(status.pendingIds.includes("0000-00-00T00-00-00Z__removed-from-tree")).toBe(false);
  expect(status.checksumMismatches).toEqual([]);
  expect(status.legacyChecksumMismatches).toEqual([]);
});

test("fully applied tree: nothing pending", async () => {
  const col = handle.rawDb.collection<MigrationDoc>(MIGRATIONS_COLLECTION);
  for (const m of allMigrations) await col.insertOne(appliedRecord(m, m.checksum));

  const status = await getMigrationStatus(handle.rawDb);
  expect(status.applied).toBe(allMigrations.length);
  expect(status.pending).toBe(0);
  expect(status.pendingIds).toEqual([]);
  expect(status.checksumMismatches).toEqual([]);
  expect(status.legacyChecksumMismatches).toEqual([]);
});

test("edited file body on an enforcement-era id lands in checksumMismatches", async () => {
  const target = allMigrations.find((m) => !isLegacyChecksumMismatch(m.id));
  expect(target).toBeDefined();
  if (!target) return;

  await handle.rawDb
    .collection<MigrationDoc>(MIGRATIONS_COLLECTION)
    .insertOne(appliedRecord(target, "0".repeat(64)));

  const status = await getMigrationStatus(handle.rawDb);
  expect(status.checksumMismatches).toEqual([target.id]);
  expect(status.legacyChecksumMismatches).toEqual([]);
  // A mismatched id is applied, not pending.
  expect(status.pendingIds.includes(target.id)).toBe(false);
  expect(status.pending).toBe(allMigrations.length - 1);
});

test("edited file body on a pre-rollout id lands in legacyChecksumMismatches", async () => {
  const target = allMigrations.find((m) => isLegacyChecksumMismatch(m.id));
  expect(target).toBeDefined();
  if (!target) return;

  await handle.rawDb
    .collection<MigrationDoc>(MIGRATIONS_COLLECTION)
    .insertOne(appliedRecord(target, "f".repeat(64)));

  const status = await getMigrationStatus(handle.rawDb);
  expect(status.legacyChecksumMismatches).toEqual([target.id]);
  expect(status.checksumMismatches).toEqual([]);
  expect(status.pendingIds.includes(target.id)).toBe(false);
});

test("isLegacyChecksumMismatch cutoff is the 2026-07-18 enforcement date", () => {
  expect(isLegacyChecksumMismatch("0000-00-00T00-00-00Z__bootstrap-indexes")).toBe(true);
  expect(isLegacyChecksumMismatch("2026-07-17T12-00-00Z__some-migration")).toBe(true);
  expect(isLegacyChecksumMismatch("2026-07-18T00-00-00Z__some-migration")).toBe(false);
  expect(isLegacyChecksumMismatch("2026-09-05T00-00-00Z__some-migration")).toBe(false);
});
