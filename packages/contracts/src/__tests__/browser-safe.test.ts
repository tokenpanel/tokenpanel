import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Contracts package must stay browser-safe: no Node/Bun/Mongo/Hono/process.env.
 */
// Match real imports/usages only — not documentation comments that mention names.
const FORBIDDEN =
  /(?:^|[^/\s*])\s*(?:from\s+["']node:|from\s+["']mongodb|from\s+["']bun:|from\s+["']hono|from\s+["'](?:fs|path|buffer|stream|crypto|os|http|https|child_process|net|tls|url|util|zlib|querystring)["']|require\s*\(|import\s*\(|process\.|import\.meta\.env|globalThis\.(?:Bun|process)|\bBun\.|\bMongoClient\b)/m;

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

const LEAK_FIXTURES: { name: string; code: string }[] = [
  { name: "require(node:fs)", code: `const fs = require("node:fs");` },
  { name: "dynamic import(node:fs)", code: `const fs = await import("node:fs");` },
  { name: "require(fs)", code: `const fs = require("fs");` },
  { name: "bare fs import", code: `import fs from "fs";` },
  { name: "bare path import", code: `import path from "path";` },
  { name: "bare buffer import", code: `import { Buffer } from "buffer";` },
  { name: "bare stream import", code: `import { Readable } from "stream";` },
  { name: "bare crypto import", code: `import crypto from "crypto";` },
  { name: "bare os import", code: `import os from "os";` },
  { name: "bare http import", code: `import http from "http";` },
  { name: "bare https import", code: `import https from "https";` },
  { name: "bare child_process import", code: `import { exec } from "child_process";` },
  { name: "bare net import", code: `import net from "net";` },
  { name: "bare tls import", code: `import tls from "tls";` },
  { name: "bare url import", code: `import { URL } from "url";` },
  { name: "bare util import", code: `import util from "util";` },
  { name: "bare zlib import", code: `import zlib from "zlib";` },
  { name: "bare querystring import", code: `import qs from "querystring";` },
  { name: "process.argv", code: `const argv = process.argv;` },
  { name: "process.platform", code: `const p = process.platform;` },
  { name: "process.env", code: `const e = process.env;` },
  { name: "globalThis.Bun", code: `const b = globalThis.Bun;` },
  { name: "globalThis.process", code: `const p = globalThis.process;` },
  { name: "Bun.serve", code: `const s = Bun.serve({});` },
  { name: "MongoClient", code: `const c = new MongoClient(uri);` },
];

for (const { name, code } of LEAK_FIXTURES) {
  test(`FORBIDDEN regex catches: ${name}`, () => {
    expect(code, name).toMatch(FORBIDDEN);
  });
}

test("FORBIDDEN regex does not flag safe static imports", () => {
  expect(`import { Schema } from "effect";`).not.toMatch(FORBIDDEN);
  expect(`import { Schema } from "@tokenpanel/contracts/effect";`).not.toMatch(FORBIDDEN);
  expect(`import type { Foo } from "./types";`).not.toMatch(FORBIDDEN);
});

test("FORBIDDEN regex does not flag non-node bare specifier", () => {
  expect(`import { z } from "zod";`).not.toMatch(FORBIDDEN);
  expect(`import { effect } from "effect";`).not.toMatch(FORBIDDEN);
});
