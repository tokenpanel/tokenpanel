import { validateMigrationMeta } from "../runner.ts";
import { test, expect } from "bun:test";

test("validateMigrationMeta: passes when phase + id match", () => {
  const errors = validateMigrationMeta(
    "2024-01-01T00-00-00Z__add-foo-index.ts",
    { id: "2024-01-01T00-00-00Z__add-foo-index", phase: "pre" },
    "pre",
  );
  expect(errors).toEqual([]);
});

test("validateMigrationMeta: flags phase mismatch (post file in pre/)", () => {
  const errors = validateMigrationMeta(
    "2024-01-01T00-00-00Z__drop-old.ts",
    { id: "2024-01-01T00-00-00Z__drop-old", phase: "post" },
    "pre",
  );
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain('phase="post"');
  expect(errors[0]).toContain("pre/");
});

test("validateMigrationMeta: flags id/filename mismatch", () => {
  const errors = validateMigrationMeta(
    "2024-01-01T00-00-00Z__add-foo-index.ts",
    { id: "2024-01-01T00-00-00Z__different-name", phase: "pre" },
    "pre",
  );
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("does not match filename");
});

test("validateMigrationMeta: flags both phase and id mismatch", () => {
  const errors = validateMigrationMeta(
    "2024-01-01T00-00-00Z__add-foo-index.ts",
    { id: "wrong-id", phase: "post" },
    "pre",
  );
  expect(errors.length).toBe(2);
});

test("validateMigrationMeta: strips only the .ts extension for the stem", () => {
  const errors = validateMigrationMeta(
    "0000-00-00T00-00-00Z__bootstrap-indexes.ts",
    { id: "0000-00-00T00-00-00Z__bootstrap-indexes", phase: "pre" },
    "pre",
  );
  expect(errors).toEqual([]);
});
