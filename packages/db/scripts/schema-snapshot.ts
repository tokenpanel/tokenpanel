import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as DB from "../src/index.ts";

type AnyAst = any;

function serializeAst(ast: AnyAst, seen: WeakSet<object>): unknown {
  if (ast === null || ast === undefined) return null;
  if (typeof ast !== "object") return String(ast);
  if (seen.has(ast)) return { kind: "circular" };
  seen.add(ast);

  const tag: string = ast._tag ?? "Unknown";

  if (tag === "Transformation") {
    return { kind: "transform", to: serializeAst(ast.to, seen) };
  }
  if (tag === "TypeLiteral") {
    const props = (ast.propertySignatures ?? []).map((ps: AnyAst) => ({
      name: String(ps.name),
      optional: ps.isOptional === true,
      type: serializeAst(ps.type, seen),
    }));
    props.sort((a: any, b: any) => a.name.localeCompare(b.name));
    return { kind: "struct", props };
  }
  if (tag === "Union") {
    const types = (ast.types ?? []).map((t: AnyAst) => serializeAst(t, seen));
    return { kind: "union", types };
  }
  if (tag === "Refinement") {
    return { kind: "refinement", from: serializeAst(ast.from, seen) };
  }
  if (tag === "TupleType") {
    const elements = (ast.elements ?? []).map((el: AnyAst) => serializeAst(el.type, seen));
    return { kind: "tuple", elements };
  }
  if (tag === "Declaration") {
    return { kind: "declaration", id: ast.identifier ?? "unknown" };
  }
  if (typeof ast.identifier === "string") {
    return { kind: tag, id: ast.identifier };
  }
  return { kind: tag };
}

function isSchemaLike(value: unknown): value is { ast: AnyAst } {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "ast" in value
  );
}

export function buildSnapshot(): unknown {
  const schemas: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  for (const [name, value] of Object.entries(DB)) {
    if (!name.endsWith("Doc")) continue;
    if (!isSchemaLike(value)) continue;
    schemas[name] = serializeAst((value as { ast: AnyAst }).ast, seen);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(schemas).sort()) sorted[key] = schemas[key];
  return { schema: 1, collections: DB.collections, schemas: sorted };
}

export function snapshotPath(): string {
  return join(import.meta.dir, "..", "generated", "schema-snapshot.json");
}

if (import.meta.main) {
  const outPath = snapshotPath();
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(buildSnapshot(), null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}`);
}
