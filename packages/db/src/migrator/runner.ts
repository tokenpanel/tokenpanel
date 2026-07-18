import type { Db, MongoClient } from "mongodb";
import type {
  MigrationFile,
  MigrationPhase,
  MigrationReport,
  MigrationStatus,
} from "./types.ts";
import { acquireLock } from "./lock.ts";
import { createMigrationDb } from "./migration-db.ts";
import { loadMigrationTree } from "./validator.ts";
export { validateMigrationMeta } from "./validator.ts";

const MIGRATIONS_COLLECTION = "_migrations";
const CHECKSUM_ENFORCEMENT_START_DATE = "2026-07-18";

/**
 * Migration checksums became enforceable on 2026-07-18. Earlier migration
 * records may predate checksum tracking, so their mismatch is warning-only.
 */
export function isLegacyChecksumMismatch(migrationId: string): boolean {
  return migrationId.slice(0, CHECKSUM_ENFORCEMENT_START_DATE.length) < CHECKSUM_ENFORCEMENT_START_DATE;
}

interface MigrationDoc {
  _id: string;
  phase: string;
  appliedAt: Date;
  checksum: string;
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
  const report: MigrationReport = {
    phase,
    applied: [],
    skipped: [],
    legacyChecksumMismatches: [],
  };

  const lock = await acquireLock(db);
  try {
    // Abort before reading state if the lock could not be kept alive between
    // acquire and here (e.g. MongoDB became unreachable).
    lock.assertAlive();

    const applied = await db.collection<MigrationDoc>(MIGRATIONS_COLLECTION).find({}).toArray();
    const appliedMap = new Map(
      applied.map((a) => [a._id, a.checksum]),
    );

    const files = (await loadMigrationTree())[phase];

    for (const m of files) {
      // Abort before starting the next migration if the heartbeat lost the
      // lock (expired/stolen or DB unreachable) while the previous one ran.
      lock.assertAlive();

      const existingChecksum = appliedMap.get(m.id);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== m.checksum) {
          if (isLegacyChecksumMismatch(m.id)) {
            console.warn(
              `WARNING: legacy migration "${m.id}" has a different stored checksum; ` +
                "skipping compatibility exception. Restore original bytes before any future edit.",
            );
            report.legacyChecksumMismatches.push(m.id);
            report.skipped.push(m.id);
            continue;
          }
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
  const appliedMap = new Map(appliedDocs.map((a) => [a._id, a.checksum]));

  let pending = 0;
  const pendingIds: string[] = [];
  const checksumMismatches: string[] = [];
  const legacyChecksumMismatches: string[] = [];

  const migrations = await loadMigrationTree();
  for (const phase of ["pre", "post"] as MigrationPhase[]) {
    const files = migrations[phase];
    for (const m of files) {
      const existingChecksum = appliedMap.get(m.id);
      if (existingChecksum === undefined) {
        pending++;
        pendingIds.push(m.id);
      } else if (existingChecksum !== m.checksum) {
        // Applied id with a different file body — runMigrations will refuse.
        if (isLegacyChecksumMismatch(m.id)) {
          legacyChecksumMismatches.push(m.id);
        } else {
          checksumMismatches.push(m.id);
        }
      }
    }
  }

  return {
    applied: appliedDocs.length,
    pending,
    pendingIds,
    checksumMismatches,
    legacyChecksumMismatches,
  };
}
