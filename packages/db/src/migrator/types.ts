import type { MigrationDb } from "./migration-db.ts";

export type MigrationPhase = "pre" | "post";

export interface MigrationFile {
  id: string;
  phase: MigrationPhase;
  checksum: string;
  transactional: boolean;
  up: (mdb: MigrationDb) => Promise<void>;
  down?: (mdb: MigrationDb) => Promise<void>;
}

export interface MigrationReport {
  phase: MigrationPhase;
  applied: string[];
  skipped: string[];
}

export interface MigrationStatus {
  applied: number;
  pending: number;
  pendingIds: string[];
  /**
   * Migration IDs present in `_migrations` whose on-disk checksum no longer
   * matches. `runMigrations` aborts on these; status surfaces them early.
   */
  checksumMismatches: string[];
}
