import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Contracts package must stay browser-safe: no Node/Bun/Mongo/Hono/process.env.
 */
// Match real imports/usages only — not documentation comments that mention names.
const FORBIDDEN =
  /(?:^|[^/\s*])\s*(?:from\s+["']node:|from\s+["']mongodb|from\s+["']bun:|from\s+["']hono|process\.env|import\.meta\.env|\bBun\.|\bMongoClient\b)/m;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "__tests__" || ent.name === "dist") continue;
      out.push(...walkTs(p));
    } else if (ent.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

test("contracts source has no Node/Mongo/Bun/Hono/env imports", () => {
  const root = join(import.meta.dir, "..");
  const files = walkTs(root);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    expect(src, file).not.toMatch(FORBIDDEN);
  }
});
