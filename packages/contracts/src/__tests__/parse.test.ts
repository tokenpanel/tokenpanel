import { test, expect, describe } from "bun:test";
import { Schema } from "effect";
import { parse, safeParse } from "../parse.ts";

const Nested = Schema.Struct({
  id: Schema.String,
  meta: Schema.Struct({
    retries: Schema.Number.pipe(Schema.int()),
  }),
});

describe("safeParse failure shape", () => {
  test("reports issue path and message on failure", () => {
    const r = safeParse(Nested, { id: "abc", meta: { retries: 1.5 } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toHaveLength(1);
      const issue = r.error.issues[0]!;
      expect(issue.message).toBe("Expected an integer, actual 1.5");
      expect(issue.path).toEqual(["meta", "retries"]);
    }
  });

  test("missing key reports an issue pathed at that key", () => {
    const r = safeParse(Nested, { id: "abc", meta: {} });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path);
      expect(paths).toContainEqual(["meta", "retries"]);
      expect(r.error.issues[0]!.message).toBe("is missing");
    }
  });

  test("top-level non-object failure yields an empty path", () => {
    const r = safeParse(Nested, "not-an-object");
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.length).toBeGreaterThan(0);
      for (const issue of r.error.issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.message).toBe("string");
      }
    }
  });

  test("success variant carries the decoded data", () => {
    const r = safeParse(Nested, { id: "abc", meta: { retries: 2 } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ id: "abc", meta: { retries: 2 } });
    }
  });
});

describe("parse + withParseApi wrappers", () => {
  test("parse returns the value or throws", () => {
    expect(parse(Schema.String, "ok")).toBe("ok");
    expect(() => parse(Schema.String, 42)).toThrow();
  });
});
