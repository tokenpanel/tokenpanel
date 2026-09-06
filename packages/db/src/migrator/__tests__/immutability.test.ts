import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations, executeMigration, isLegacyChecksumMismatch } from "../runner.ts";
import { validateMigrationTree } from "../validator.ts";
import type { MigrationFile } from "../types.ts";
import {
  startTestDb,
  stopTestDb,
  TEST_DB_START_TIMEOUT_MS,
  type TestDbHandle,
} from "../../test-support/memory-server.ts";

const TEST_DB = "tokenpanel_imm_it";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await startTestDb({ databaseName: TEST_DB });
  await handle.client.db(TEST_DB).dropDatabase().catch(() => {});
}, TEST_DB_START_TIMEOUT_MS);

afterAll(async () => {
  if (handle) {
    await handle.client.db(TEST_DB).dropDatabase().catch(() => {});
  }
  await stopTestDb();
});

const MIGRATION_SOURCE = (id: string): string =>
  `export const id = "${id}";\n` +
  `export const phase = "pre" as const;\n` +
  `export const transactional = false as const;\n` +
  `export async function up(): Promise<void> {}\n`;

test("checksum changes when migration file body is edited", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpanel-imm-"));
  try {
    await mkdir(join(root, "pre"));
    await mkdir(join(root, "post"));
    const id = "2026-01-01T00-00-00Z__immutable-test";
    const original = MIGRATION_SOURCE(id);
    await writeFile(join(root, "pre", `${id}.ts`), original);

    const result1 = await validateMigrationTree(root);
    expect(result1.errors).toEqual([]);
    expect(result1.migrations.pre.length).toBe(1);
    const checksum1 = result1.migrations.pre[0]!.checksum;
    expect(checksum1).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(join(root, "pre", `${id}.ts`), original + "\n");
    const result2 = await validateMigrationTree(root);

    expect(result2.errors).toEqual([]);
    const checksum2 = result2.migrations.pre[0]!.checksum;
    expect(checksum2).toMatch(/^[0-9a-f]{64}$/);

    expect(checksum1).not.toBe(checksum2);

    const expectedMsg =
      `Migration "${id}" was already applied with a different checksum.\n` +
      `The file has been edited after application. This is unsafe —\n` +
      `either restore the original file or create a new migration.`;
    expect(expectedMsg).toContain("already applied with a different checksum");
    expect(expectedMsg).toContain(id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checksum compatibility exception ends before 2026-07-18", () => {
  expect(isLegacyChecksumMismatch("2026-07-17T23-59-59Z__legacy")).toBe(true);
  expect(isLegacyChecksumMismatch("2026-07-18T00-00-00Z__enforced")).toBe(false);
  expect(isLegacyChecksumMismatch("2026-12-31T00-00-00Z__enforced")).toBe(false);
});

describe("migration immutability guarantee", () => {
  test("executeMigration records checksum; mismatch detected on file edit", async () => {
    const db = handle.rawDb;
    const root = await mkdtemp(join(tmpdir(), "tokenpanel-imm-it-"));
    try {
      await mkdir(join(root, "pre"));
      await mkdir(join(root, "post"));
      const id = "2026-01-01T00-00-00Z__imm-execute-test";
      const original = MIGRATION_SOURCE(id);
      await writeFile(join(root, "pre", `${id}.ts`), original);

      const result1 = await validateMigrationTree(root);
      expect(result1.errors).toEqual([]);
      const mig1 = result1.migrations.pre[0];
      expect(mig1).toBeDefined();
      const originalChecksum = mig1!.checksum;

      const m: MigrationFile = {
        id: mig1!.id,
        phase: "pre",
        checksum: originalChecksum,
        transactional: false,
        up: async () => {},
      };
      await executeMigration(handle.client, db, m);

      const record = await db
        .collection<{ _id: string; checksum: string }>("_migrations")
        .findOne({ _id: id });
      expect(record).not.toBeNull();
      expect(record!.checksum).toBe(originalChecksum);

      await writeFile(join(root, "pre", `${id}.ts`), original + "\n");

      const result2 = await validateMigrationTree(root);
      expect(result2.errors).toEqual([]);
      const mig2 = result2.migrations.pre[0];
      expect(mig2).toBeDefined();
      const editedChecksum = mig2!.checksum;

      expect(originalChecksum).not.toBe(editedChecksum);
      expect(record!.checksum).not.toBe(editedChecksum);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runMigrations throws checksum-mismatch error when file edited after apply", async () => {
    const db = handle.rawDb;
    const BOOTSTRAP_ID = "2026-07-18T00-00-00Z__checksum-enforcement-test";
    const root = await mkdtemp(join(tmpdir(), "tokenpanel-imm-run-"));

    try {
      await mkdir(join(root, "pre"));
      await mkdir(join(root, "post"));
      await writeFile(join(root, "pre", `${BOOTSTRAP_ID}.ts`), MIGRATION_SOURCE(BOOTSTRAP_ID));

      await db.collection<{ _id: string; phase: string; appliedAt: Date; checksum: string }>("_migrations").insertOne({
        _id: BOOTSTRAP_ID,
        phase: "pre",
        appliedAt: new Date(),
        checksum: "0".repeat(64),
      });

      await runMigrations(handle.client, db, "pre", { root });
      expect.unreachable("runMigrations should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("already applied with a different checksum");
      expect(msg).toContain(BOOTSTRAP_ID);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
