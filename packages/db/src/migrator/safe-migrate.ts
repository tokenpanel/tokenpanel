interface ForbiddenPattern {
  pattern: RegExp;
  description: string;
}

const FORBIDDEN_IN_PRE: ForbiddenPattern[] = [
  { pattern: /\.drop\s*\(/, description: ".drop() — drops entire collection" },
  { pattern: /\.dropIndex/, description: ".dropIndex() / .dropIndexes() — drops indexes" },
  { pattern: /\.renameCollection\s*\(/, description: ".renameCollection() — renames collection" },
  { pattern: /\bcollMod\b/, description: "collMod — modifies collection options/validators" },
  { pattern: /\$unset\b/, description: "$unset — removes fields from documents (data loss)" },
  { pattern: /\$rename\b/, description: "$rename — renames document fields (data mutation)" },
  // Deletion methods and bulkWrite delete operations (deleteOne/deleteMany appear
  // both as method calls `.deleteOne(` and as bulkWrite op keys `{ deleteOne: ... }`).
  { pattern: /\bdeleteMany\b/, description: "deleteMany — deletes documents (method or bulkWrite op)" },
  { pattern: /\bdeleteOne\b/, description: "deleteOne — deletes a document (method or bulkWrite op)" },
  { pattern: /\.findOneAndDelete\s*\(/, description: ".findOneAndDelete() — deletes and returns a document" },
];

/**
 * Commands explicitly allowed inside `pre/` migrations (additive / read-only).
 * Any other `db.command({ <name>: ... })` in `pre/` is treated as suspicious
 * because destructive commands (drop, dropDatabase, dropIndexes,
 * renameCollection, collMod, delete, ...) can be issued through `db.command()`.
 */
const SAFE_COMMANDS = new Set([
  "createIndexes",
  "createCollection",
  "listCollections",
  "listIndexes",
  "ping",
  "hello",
  "dbStats",
  "collStats",
  "count",
  "distinct",
  "buildInfo",
]);

/**
 * Scan `db.command()` / `.command()` calls and flag any whose command name is
 * not in {@link SAFE_COMMANDS}. Destructive commands (drop, dropDatabase,
 * dropIndexes, renameCollection, collMod, delete, ...) can be issued through
 * `db.command()`, so unknown commands are treated as suspicious in `pre/`.
 *
 * The regex captures the command name (the first identifier after the opening
 * `{` or a quoted string form like `.command("ping")`) directly in capture
 * group 1 — it must span past `.command(` into the command document, not stop
 * at the paren.
 */
function scanCommands(upOnly: string, violations: string[]): void {
  const commandCallRegex = /\.command\s*\(\s*\{?\s*["']?([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = commandCallRegex.exec(upOnly)) !== null) {
    const name = match[1];
    if (name && !SAFE_COMMANDS.has(name)) {
      violations.push(
        `db.command({ ${name}: ... }) — command not in safe allowlist for pre/ migrations (destructive risk); move to migrations/post/`,
      );
    }
  }
}

export function lintMigration(content: string): string[] {
  const parts = content.split(/export\s+async\s+function\s+down/);
  const upOnly = parts[0] ?? content;

  const violations: string[] = [];
  for (const { pattern, description } of FORBIDDEN_IN_PRE) {
    if (pattern.test(upOnly)) {
      violations.push(description);
    }
  }

  scanCommands(upOnly, violations);

  // De-duplicate while preserving order.
  return [...new Set(violations)];
}
