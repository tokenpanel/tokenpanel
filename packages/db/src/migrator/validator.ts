import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lintMigration, lintMigrationImports } from "./safe-migrate.ts";
import type { MigrationFile, MigrationPhase } from "./types.ts";

const PHASES = ["pre", "post"] as const satisfies readonly MigrationPhase[];
const MIGRATION_FILENAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__[A-Za-z0-9][A-Za-z0-9_-]*\.ts$/;

export interface MigrationTree {
  pre: MigrationFile[];
  post: MigrationFile[];
}

export interface MigrationTreeValidation {
  errors: string[];
  migrations: MigrationTree;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMigrationFunction(value: unknown): value is MigrationFile["up"] {
  return typeof value === "function";
}

/** Validate exported metadata against migration filename and directory. */
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

async function readPhaseEntries(
  root: string,
  phase: MigrationPhase,
  errors: string[],
): Promise<Dirent[]> {
  try {
    return (await readdir(join(root, phase), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (error) {
    errors.push(
      `migrations/${phase}: cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function validatePhase(
  root: string,
  phase: MigrationPhase,
  errors: string[],
): Promise<MigrationFile[]> {
  const migrations: MigrationFile[] = [];
  const entries = await readPhaseEntries(root, phase, errors);

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const label = `migrations/${phase}/${entry.name}`;
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      errors.push(`${label}: unexpected entry; migration directories may contain only .ts files`);
      continue;
    }
    if (!MIGRATION_FILENAME.test(entry.name)) {
      errors.push(`${label}: invalid filename; expected YYYY-MM-DDTHH-MM-SSZ__name.ts`);
    }

    const filePath = join(root, phase, entry.name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      errors.push(
        `${label}: cannot read file: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const sourceViolations = lintMigrationImports(content);
    if (phase === "pre") sourceViolations.push(...lintMigration(content));
    if (sourceViolations.length > 0) {
      errors.push(...sourceViolations.map((violation) => `${label}: ${violation}`));
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
    } catch (error) {
      errors.push(
        `${label}: cannot import module: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (
      typeof mod.id !== "string" ||
      typeof mod.phase !== "string" ||
      !isMigrationFunction(mod.up)
    ) {
      errors.push(`${label}: must export id (string), phase ('pre'|'post'), and up (function)`);
      continue;
    }
    if (typeof mod.transactional !== "boolean") {
      errors.push(`${label}: must explicitly export transactional (boolean)`);
      continue;
    }
    if (mod.down !== undefined && !isMigrationFunction(mod.down)) {
      errors.push(`${label}: down must be a function when exported`);
      continue;
    }

    const metaErrors = validateMigrationMeta(
      entry.name,
      { id: mod.id, phase: mod.phase },
      phase,
    );
    if (metaErrors.length > 0) {
      errors.push(...metaErrors.map((error) => `${label}: ${error}`));
      continue;
    }

    migrations.push({
      id: mod.id,
      phase,
      checksum: sha256(content),
      transactional: mod.transactional,
      up: mod.up,
      ...(isMigrationFunction(mod.down) ? { down: mod.down } : {}),
    });
  }

  return migrations;
}

/** Validate and load every committed migration without connecting to MongoDB. */
export async function validateMigrationTree(
  root = join(import.meta.dir, "..", "..", "migrations"),
): Promise<MigrationTreeValidation> {
  const errors: string[] = [];
  const migrations: MigrationTree = { pre: [], post: [] };

  for (const phase of PHASES) {
    migrations[phase] = await validatePhase(root, phase, errors);
  }

  const owners = new Map<string, MigrationPhase>();
  for (const phase of PHASES) {
    for (const migration of migrations[phase]) {
      const owner = owners.get(migration.id);
      if (owner !== undefined) {
        errors.push(
          `migration id "${migration.id}" is duplicated in migrations/${owner}/ and migrations/${phase}/`,
        );
      } else {
        owners.set(migration.id, phase);
      }
    }
  }

  return { errors, migrations };
}

/** Load migrations or throw one error containing every policy violation. */
export async function loadMigrationTree(root?: string): Promise<MigrationTree> {
  const result = await validateMigrationTree(root);
  if (result.errors.length > 0) {
    throw new Error(
      "Invalid migration tree:\n" + result.errors.map((error) => `  ✗ ${error}`).join("\n"),
    );
  }
  return result.migrations;
}
