import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMigrationTree } from "../validator.ts";

test("all committed migrations follow migration policy", async () => {
  const result = await validateMigrationTree();
  expect(result.errors).toEqual([]);
  expect(result.migrations.pre.length).toBeGreaterThan(0);
  expect(result.migrations.post.length).toBeGreaterThan(0);
});

test("migration policy rejects duplicate ids across phases", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpanel-migrations-"));
  const id = "2026-01-01T00-00-00Z__duplicate";
  try {
    await Promise.all([
      mkdir(join(root, "pre")),
      mkdir(join(root, "post")),
    ]);
    await Promise.all(
      (["pre", "post"] as const).map((phase) =>
        writeFile(
          join(root, phase, `${id}.ts`),
          `export const id = "${id}";
export const phase = "${phase}" as const;
export const transactional = true as const;
export async function up(): Promise<void> {}
`,
        ),
      ),
    );

    const result = await validateMigrationTree(root);
    expect(result.errors.some((error) => error.includes("duplicated"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
