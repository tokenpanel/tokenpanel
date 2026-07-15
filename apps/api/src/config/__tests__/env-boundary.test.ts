import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Application process.env reads should stay at executable/config boundaries.
 * Allowed: config/runtime, config/state (transitional JWT), crypto transitional,
 * index boot (via runtime), migrator is in packages/db.
 */
const API_SRC = join(import.meta.dir, "../..");

const ALLOWLIST = new Set([
  "config/runtime.ts",
  "config/state.ts",
  "lib/crypto.ts", // transitional JWT fallback when config unset
  "index.ts", // parseApiRuntimeConfig(process.env) only
]);

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "dist") continue;
    const p = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(p).isDirectory()) out.push(...walk(p, rel));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

test("process.env confined to allowlisted API modules", () => {
  const files = walk(API_SRC);
  const offenders: string[] = [];
  for (const rel of files) {
    if (ALLOWLIST.has(rel)) continue;
    if (rel.includes("__tests__")) continue;
    const src = readFileSync(join(API_SRC, rel), "utf8");
    if (/process\.env\b/.test(src)) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});
