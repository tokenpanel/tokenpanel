import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  configureDb,
  getDb,
  getRawDb,
  getClient,
  closeDb,
} from "../client.ts";
import { parseMigratorEnv } from "./env.ts";
import { runMigrations, getMigrationStatus } from "./runner.ts";
import type { MigrationPhase } from "./types.ts";

function bootDbFromEnv(): void {
  const cfg = parseMigratorEnv(process.env);
  configureDb({ uri: cfg.uri, databaseName: cfg.databaseName });
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "";

  switch (cmd) {
    case "run": {
      const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
      const phase = (phaseArg?.split("=")[1] ?? "pre") as MigrationPhase;
      if (phase !== "pre" && phase !== "post") {
        console.error(`Invalid phase: ${phase}. Use 'pre' or 'post'.`);
        process.exit(1);
      }
      bootDbFromEnv();
      await getDb();
      const db = getRawDb();
      const client = getClient();
      const report = await runMigrations(client, db, phase);
      console.log(
        `${phase} migrations: ${report.applied.length} applied, ${report.skipped.length} skipped`,
      );
      for (const id of report.applied) console.log(`  ✓ ${id}`);
      const legacyMismatchIds = new Set(report.legacyChecksumMismatches);
      for (const id of report.skipped) {
        console.log(
          legacyMismatchIds.has(id)
            ? `  ! ${id} (legacy checksum mismatch; compatibility skip)`
            : `  → ${id} (already applied)`,
        );
      }
      await closeDb();
      break;
    }
    case "status": {
      bootDbFromEnv();
      await getDb();
      const db = getRawDb();
      const status = await getMigrationStatus(db);
      console.log(`Applied: ${status.applied}`);
      console.log(`Pending: ${status.pending}`);
      for (const id of status.pendingIds) console.log(`  ○ ${id}`);
      if (status.checksumMismatches.length > 0) {
        console.log(`Checksum mismatches: ${status.checksumMismatches.length}`);
      for (const id of status.checksumMismatches) {
        console.log(`  ✗ ${id} (file edited after apply — run will abort)`);
      }
      if (status.legacyChecksumMismatches.length > 0) {
        console.warn(`Legacy checksum mismatches: ${status.legacyChecksumMismatches.length}`);
        for (const id of status.legacyChecksumMismatches) {
          console.warn(`  ! ${id} (compatibility exception; restore original bytes before future edit)`);
        }
      }
      }
      await closeDb();
      break;
    }
    case "new": {
      const nameArg = process.argv.find((a) => a.startsWith("--name="));
      const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
      if (!nameArg) {
        console.error("Usage: bun run src/migrator/cli.ts new --name=<name> [--phase=<pre|post>]");
        process.exit(1);
      }
      const name = nameArg.split("=")[1];
      if (!name) {
        console.error("--name= requires a value");
        process.exit(1);
      }
      const phase = (phaseArg?.split("=")[1] ?? "pre") as MigrationPhase;
      if (phase !== "pre" && phase !== "post") {
        console.error(`Invalid phase: ${phase}. Use 'pre' or 'post'.`);
        process.exit(1);
      }
      const slug = name.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
      const id = `${ts}Z__${slug}`;
      const dir = join(import.meta.dir, "..", "..", "migrations", phase);
      mkdirSync(dir, { recursive: true });
      const filepath = join(dir, `${id}.ts`);
      const template = `import type { MigrationDb } from "../../src/migrator/migration-db.ts";

export const id = "${id}";
export const phase = "${phase}" as const;
export const transactional = true as const;

export async function up(mdb: MigrationDb): Promise<void> {
  // TODO: implement migration (use mdb — every op is session-bound).
}

export async function down(mdb: MigrationDb): Promise<void> {
  // TODO: implement rollback (optional).
}
`;
      writeFileSync(filepath, template);
      console.log(`Created: migrations/${phase}/${id}.ts`);
      break;
    }
    default:
      console.error("Usage: bun run src/migrator/cli.ts [run|status|new] [options]");
      console.error("  run   [--phase=pre|post]  Apply pending migrations");
      console.error("  status                     Show applied vs pending");
      console.error("  new   --name=<name> [--phase=pre|post]  Scaffold a new migration");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
