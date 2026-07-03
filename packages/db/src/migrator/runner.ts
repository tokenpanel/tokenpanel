import type { Db, MongoClient } from "mongodb";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type {
  MigrationFile,
  MigrationPhase,
  MigrationReport,
  MigrationStatus,
} from "./types.ts";
import { acquireLock } from "./lock.ts";
import { createMigrationDb } from "./migration-db.ts";
import { lintMigration } from "./safe-migrate.ts";

const MIGRATIONS_COLLECTION = "_migrations";

interface MigrationDoc {
  _id: string;
  phase: string;
  appliedAt: Date;
  checksum: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Validate that a migration file's exported metadata matches its location:
 *  - `meta.phase` must equal the directory phase (`pre`/`post`), so a `post/`
 *    migration that accidentally lives in `pre/` (or vice versa) cannot run in
 *    the wrong phase.
 *  - `meta.id` must match the filename stem, so renaming a file or editing its
 *    `id` export is caught (the id is the `_migrations` record key).
 *
 * Pure (no I/O) so it can be unit-tested directly.
 */
export function validateMigrationMeta(
  filename: string,
  meta: { id: string; phase: string },
  expectedPhase: MigrationPhase,
): string[] {
  const errors: string[] = [];
  const stem = filename.replace(/\.ts$/, "");
  if (meta.phase !== expectedPhase) {
    errors.push(
      `file declares phase="${meta.phase}" but lives in migrations/${expectedPhase}/`,
    );
  }
  if (meta.id !== stem) {
    errors.push(`exported id="${meta.id}" does not match filename "${stem}"`);
  }
  return errors;
}

async function loadMigrations(phase: MigrationPhase): Promise<MigrationFile[]> {
  const dir = join(import.meta.dir, "..", "..", "migrations", phase);
  const files = await readdir(dir).catch(() => []);
  const sorted = files.filter((f) => f.endsWith(".ts") && !f.startsWith(".")).sort();

  const migrations: MigrationFile[] = [];
  for (const file of sorted) {
    const filePath = join(dir, file);
    const content = await readFile(filePath, "utf-8");

    if (phase === "pre") {
      const violations = lintMigration(content);
      if (violations.length > 0) {
        throw new Error(
          `SafeMigrate violation in migrations/pre/${file}:\n` +
            violations.map((v) => `  ✗ ${v}`).join("\n") +
            "\nDestructive operations must go in migrations/post/.",
        );
      }
    }

    const mod = await import(filePath);

    if (typeof mod.id !== "string" || typeof mod.phase !== "string" || typeof mod.up !== "function") {
      throw new Error(
        `Invalid migration file: ${file} — must export id (string), phase ('pre'|'post'), up (async function)`,
      );
    }

    const metaErrors = validateMigrationMeta(file, { id: mod.id, phase: mod.phase }, phase);
    if (metaErrors.length > 0) {
      throw new Error(
        `Invalid migration file: migrations/${phase}/${file}:\n` +
          metaErrors.map((e) => `  ✗ ${e}`).join("\n"),
      );
    }

    migrations.push({
      id: mod.id,
      phase: mod.phase as MigrationPhase,
      checksum: sha256(content),
      transactional: mod.transactional !== false,
      up: mod.up,
      down: mod.down,
    });
  }
  return migrations;
}

/**
 * Apply a single migration within a session. When `m.transactional` is true,
 * the migration's `up()` AND the `_migrations` record insert run inside one
 * `withTransaction`, so a throwing migration rolls back *both* its data writes
 * and the applied-state record (preventing silent double-applies on retry).
 *
 * The migration receives a {@link MigrationDb} (`mdb`) — a session-bound view —
 * so it structurally cannot forget `{ session }`. Exported for integration
 * testing of the rollback guarantee.
 */
export async function executeMigration(
  client: MongoClient,
  db: Db,
  m: MigrationFile,
): Promise<void> {
  await client.withSession(async (session) => {
    const mdb = createMigrationDb(db, session);
    const record: MigrationDoc = {
      _id: m.id,
      phase: m.phase,
      appliedAt: new Date(),
      checksum: m.checksum,
    };
    if (m.transactional) {
      await session.withTransaction(async () => {
        await m.up(mdb);
        await db.collection<MigrationDoc>(MIGRATIONS_COLLECTION).insertOne(record, { session });
      });
    } else {
      await m.up(mdb);
      await db.collection<MigrationDoc>(MIGRATIONS_COLLECTION).insertOne(record, { session });
    }
  });
}

export async function runMigrations(
  client: MongoClient,
  db: Db,
  phase: MigrationPhase,
): Promise<MigrationReport> {
  const report: MigrationReport = { phase, applied: [], skipped: [] };

  const lock = await acquireLock(db);
  try {
    // Abort before reading state if the lock could not be kept alive between
    // acquire and here (e.g. MongoDB became unreachable).
    lock.assertAlive();

    const applied = await db.collection<MigrationDoc>(MIGRATIONS_COLLECTION).find({}).toArray();
    const appliedMap = new Map(
      applied.map((a) => [a._id, a.checksum]),
    );

    const files = await loadMigrations(phase);

    for (const m of files) {
      // Abort before starting the next migration if the heartbeat lost the
      // lock (expired/stolen or DB unreachable) while the previous one ran.
      lock.assertAlive();

      const existingChecksum = appliedMap.get(m.id);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== m.checksum) {
          throw new Error(
            `Migration "${m.id}" was already applied with a different checksum.\n` +
              `The file has been edited after application. This is unsafe —\n` +
              `either restore the original file or create a new migration.`,
          );
        }
        report.skipped.push(m.id);
        continue;
      }

      await executeMigration(client, db, m);
      report.applied.push(m.id);
    }

    // Final guard: if the last migration outlasted the lock, don't report
    // success — another runner may have started applying migrations.
    lock.assertAlive();
    return report;
  } finally {
    await lock.release();
  }
}

export async function getMigrationStatus(db: Db): Promise<MigrationStatus> {
  const appliedDocs = await db.collection<MigrationDoc>(MIGRATIONS_COLLECTION).find({}).toArray();
  const appliedIds = new Set(appliedDocs.map((a) => a._id));

  let pending = 0;
  const pendingIds: string[] = [];

  for (const phase of ["pre", "post"] as MigrationPhase[]) {
    const files = await loadMigrations(phase).catch(() => []);
    for (const m of files) {
      if (!appliedIds.has(m.id)) {
        pending++;
        pendingIds.push(m.id);
      }
    }
  }

  return {
    applied: appliedDocs.length,
    pending,
    pendingIds,
  };
}
