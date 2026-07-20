import { existsSync, readFileSync } from "node:fs";
import { buildSnapshot, snapshotPath } from "./schema-snapshot.ts";

const path = snapshotPath();
const current = `${JSON.stringify(buildSnapshot(), null, 2)}\n`;

if (!existsSync(path)) {
  console.error(`schema snapshot missing: ${path}\nrun: bun run db:schema-snapshot`);
  process.exit(1);
}

const committed = readFileSync(path, "utf8");
if (committed !== current) {
  console.error("DB schema drift detected.");
  console.error("If this change is intentional:");
  console.error("  1. create a migration: bun run --filter @tokenpanel/db db:new-migration");
  console.error("  2. refresh the snapshot: bun run --filter @tokenpanel/db db:schema-snapshot");
  console.error("  3. commit both together");
  process.exit(1);
}

console.log("DB schema snapshot up to date");
