import { test, expect, describe } from "bun:test";
import { MODEL_METADATA_MAX_ENTRIES, parseStringRecord } from "../model.ts";

// parseStringRecord backs ModelMetadataInput (write mode) and the stored
// decode path — accept + reject branches per mode.

describe("parseStringRecord write mode", () => {
  test("accepts a plain string→string record", () => {
    const parsed = parseStringRecord({ tier: "pro", region: "eu" }, { mode: "write" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data["tier"]).toBe("pro");
      expect(parsed.data["region"]).toBe("eu");
    }
  });

  test("undefined yields an empty record", () => {
    const parsed = parseStringRecord(undefined, { mode: "write" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.keys(parsed.data)).toEqual([]);
  });

  test("normalizes CRLF/CR newlines in values", () => {
    const parsed = parseStringRecord({ note: "a\r\nb\rc" }, { mode: "write" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data["note"]).toBe("a\nb\nc");
  });

  test("rejects non-object values (null, array, string, number)", () => {
    for (const bad of [null, ["x"], "obj", 5, true]) {
      const parsed = parseStringRecord(bad, { mode: "write" });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.issues[0]?.message).toContain("must be an object");
    }
  });

  test("rejects non-plain objects with a type name (Date, class instance)", () => {
    const parsed = parseStringRecord(new Date(), { mode: "write" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.message).toContain("plain object (got Date)");

    class Wrapper {
      tag = "x";
    }
    const instanceParsed = parseStringRecord(new Wrapper(), { mode: "write" });
    expect(instanceParsed.ok).toBe(false);
    if (!instanceParsed.ok) {
      expect(instanceParsed.issues[0]?.message).toContain("plain object (got Wrapper)");
    }
  });

  test("rejects symbol keys", () => {
    const sym = Symbol("k");
    const parsed = parseStringRecord({ [sym]: "v" }, { mode: "write" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.message).toContain("keys must be strings");
  });

  test("rejects non-string values with a per-key path", () => {
    const parsed = parseStringRecord({ ok: "yes", bad: 42 }, { mode: "write" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0]?.path).toEqual(["bad"]);
      expect(parsed.issues[0]?.message).toContain("values must be strings");
    }
  });

  test("rejects invalid keys: leading $, reserved key, overlong after trim", () => {
    expect(parseStringRecord({ "$bad": "v" }, { mode: "write" }).ok).toBe(false);
    // A `{"__proto__": ...}` literal would not create an own key; build the
    // object the way a JSON payload would arrive.
    const reserved = JSON.parse('{"__proto__": "v"}') as Record<string, string>;
    expect(parseStringRecord(reserved, { mode: "write" }).ok).toBe(false);
    expect(
      parseStringRecord({ [`${"k".repeat(81)}`]: "v" }, { mode: "write" }).ok,
    ).toBe(false);
    // Empty key after trim.
    expect(parseStringRecord({ "   ": "v" }, { mode: "write" }).ok).toBe(false);
  });

  test("trims keys on write and flags duplicates after trim", () => {
    const parsed = parseStringRecord({ "  a  ": "1", "a": "2" }, { mode: "write" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.message).toContain("duplicate metadata key");

    const okParsed = parseStringRecord({ "  b  ": "1" }, { mode: "write" });
    expect(okParsed.ok).toBe(true);
    if (okParsed.ok) {
      expect(Object.keys(okParsed.data)).toEqual(["b"]);
      expect(okParsed.data["b"]).toBe("1");
    }
  });

  test("value over 2000 chars is rejected on write", () => {
    const parsed = parseStringRecord({ big: "v".repeat(2001) }, { mode: "write" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues[0]?.path).toEqual(["big"]);
      expect(parsed.issues[0]?.message).toContain("at most 2000");
    }
  });

  test("collects multiple issues across keys", () => {
    const parsed = parseStringRecord({ a: 1, b: null }, { mode: "write" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toHaveLength(2);
      expect(parsed.issues.map((i) => i.path[0])).toEqual(["a", "b"]);
    }
  });
});

describe("parseStringRecord stored mode", () => {
  test("skips write-only policy checks (entry count, key validation)", () => {
    // Stored rows may hold keys/entries written before (or outside) the write
    // policy; stored mode must decode them.
    const many: Record<string, string> = {};
    for (let i = 0; i <= MODEL_METADATA_MAX_ENTRIES + 5; i++) many[`k${i}`] = "v";
    expect(parseStringRecord(many, { mode: "stored" }).ok).toBe(true);

    expect(parseStringRecord({ "$legacy": "v" }, { mode: "stored" }).ok).toBe(true);
  });

  test("still requires an object of string values", () => {
    expect(parseStringRecord(null, { mode: "stored" }).ok).toBe(false);
    expect(parseStringRecord("nope", { mode: "stored" }).ok).toBe(false);
    expect(parseStringRecord({ x: 1 }, { mode: "stored" }).ok).toBe(false);
    expect(parseStringRecord({ x: "ok" }, { mode: "stored" }).ok).toBe(true);
  });
});
