import { test, expect, describe } from "bun:test";
import { Schema } from "effect";
import { parse, safeParse, withParseApi } from "../parse.ts";

// Effect Schema decode helpers: success passthrough, failure issue shape,
// and the withParseApi method attachment.

const Positive = Schema.Number.pipe(Schema.positive());

describe("parse", () => {
  test("returns the decoded value on success", () => {
    expect(parse(Positive, 5)).toBe(5);
    expect(parse(Schema.String, "hi")).toBe("hi");
  });

  test("applies schema transforms (decode side)", () => {
    const Len = Schema.transform(Schema.String, Schema.Number, {
      strict: true,
      decode: (s) => s.length,
      encode: (n) => String(n),
    });
    expect(parse(Len, "abcd")).toBe(4);
  });

  test("throws ParseError on invalid input", () => {
    expect(() => parse(Positive, -1)).toThrow();
    expect(() => parse(Positive, "not a number")).toThrow();
  });
});

describe("safeParse", () => {
  test("success branch: { success: true, data }", () => {
    const result = safeParse(Positive, 42);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(42);
  });

  test("failure branch: ParseError name, issues with path+message, flatten()", () => {
    // Effect Schema Struct decoding is fail-fast: exactly one issue for the
    // first failing field.
    const result = safeParse(
      Schema.Struct({ name: Schema.String, age: Positive }),
      { name: 7, age: -3 },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe("ParseError");
      expect(result.error.issues).toHaveLength(1);
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(["name"]);
      expect(typeof issue?.message).toBe("string");

      const flattened = result.error.flatten();
      expect(flattened.fieldErrors["name"]).toBeDefined();
      expect(flattened.fieldErrors["name"]?.length).toBeGreaterThan(0);
      expect(flattened.formErrors).toEqual([]);
    }
  });

  test("root-level failure lands in formErrors via flatten()", () => {
    const result = safeParse(Positive, -5);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([]);
      const flattened = result.error.flatten();
      expect(flattened.formErrors.length).toBeGreaterThan(0);
    }
  });

  test("array element failures carry an index path", () => {
    const result = safeParse(
      Schema.Array(Schema.Number.pipe(Schema.positive())),
      [1, -1, 2, -3],
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      // Fail-fast: first bad element only.
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.path).toEqual([1]);
      const flattened = result.error.flatten();
      expect(flattened.fieldErrors["1"]).toBeDefined();
    }
  });
});


describe("withParseApi", () => {
  test("attaches parse/safeParse that agree with the standalone helpers", () => {
    const wrapped = withParseApi(Positive);
    expect(wrapped.parse(3)).toBe(3);
    expect(() => wrapped.parse(-2)).toThrow();

    const ok = wrapped.safeParse(3);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toBe(3);

    const bad = wrapped.safeParse(-2);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.name).toBe("ParseError");
  });

  test("built schema still decodes through its own contract", () => {
    const wrapped = withParseApi(
      Schema.Struct({
        id: Schema.String,
        count: Schema.optionalWith(Schema.Number, { default: () => 0 }),
      }),
    );
    const decoded = wrapped.parse({ id: "x" });
    expect(decoded).toEqual({ id: "x", count: 0 });
  });
});
