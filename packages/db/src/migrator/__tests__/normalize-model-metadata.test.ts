import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  convertLegacyMetadataValue,
  normalizeModelMetadata,
  setOwnString,
  assertJsonSafeTree,
} from "../../../migrations/post/2026-07-13T00-00-00Z__normalize-model-metadata.ts";

// Match the inlined migration constants (not live schema exports).
const METADATA_MAX_ENTRIES = 50;
const METADATA_VALUE_MAX_LEN = 2000;

const mid = "deadbeefdeadbeefdeadbeef (my-gpt)";

test("convertLegacyMetadataValue: preserves strings with CR→LF", () => {
  expect(convertLegacyMetadataValue("gold", mid, "tier")).toBe("gold");
  expect(convertLegacyMetadataValue("", mid, "tier")).toBe("");
  expect(convertLegacyMetadataValue("a\r\nb\rc", mid, "tier")).toBe("a\nb\nc");
});

test("convertLegacyMetadataValue: finite primitives via String", () => {
  expect(convertLegacyMetadataValue(42, mid, "n")).toBe("42");
  expect(convertLegacyMetadataValue(true, mid, "b")).toBe("true");
  expect(convertLegacyMetadataValue(false, mid, "b")).toBe("false");
  expect(convertLegacyMetadataValue(null, mid, "x")).toBe("null");
});

test("convertLegacyMetadataValue: rejects non-finite numbers", () => {
  expect(() => convertLegacyMetadataValue(NaN, mid, "n")).toThrow(/non-finite/);
  expect(() => convertLegacyMetadataValue(Infinity, mid, "n")).toThrow(/non-finite/);
  expect(() => convertLegacyMetadataValue(-Infinity, mid, "n")).toThrow(/non-finite/);
});

test("convertLegacyMetadataValue: arrays/objects via JSON.stringify", () => {
  expect(convertLegacyMetadataValue([1, "a"], mid, "arr")).toBe('[1,"a"]');
  expect(convertLegacyMetadataValue({ a: 1, b: "x" }, mid, "obj")).toBe(
    '{"a":1,"b":"x"}',
  );
});

test("convertLegacyMetadataValue: aborts on Date / ObjectId / RegExp / Map", () => {
  expect(() => convertLegacyMetadataValue(new Date(), mid, "d")).toThrow(
    /unconvertible BSON/,
  );
  expect(() => convertLegacyMetadataValue(new ObjectId(), mid, "id")).toThrow(
    /unconvertible BSON/,
  );
  expect(() => convertLegacyMetadataValue(/x/, mid, "re")).toThrow(
    /unconvertible BSON/,
  );
  expect(() => convertLegacyMetadataValue(new Map(), mid, "m")).toThrow(
    /unconvertible BSON/,
  );
});

test("convertLegacyMetadataValue: nested Date/ObjectId/NaN abort (not stringify)", () => {
  expect(() =>
    convertLegacyMetadataValue({ when: new Date() }, mid, "nested"),
  ).toThrow(/unconvertible BSON/);
  expect(() =>
    convertLegacyMetadataValue({ id: new ObjectId() }, mid, "nested"),
  ).toThrow(/unconvertible BSON/);
  expect(() =>
    convertLegacyMetadataValue([{ x: new Date() }], mid, "arr"),
  ).toThrow(/unconvertible BSON/);
  expect(() =>
    convertLegacyMetadataValue({ n: NaN }, mid, "nested"),
  ).toThrow(/non-finite/);
  expect(() =>
    convertLegacyMetadataValue({ n: Infinity }, mid, "nested"),
  ).toThrow(/non-finite/);
});

test("assertJsonSafeTree: accepts plain JSON trees", () => {
  expect(() =>
    assertJsonSafeTree({ a: [1, { b: "c" }], d: null }, mid, "k", "k"),
  ).not.toThrow();
});

test("normalizeModelMetadata: missing → empty object", () => {
  const r = normalizeModelMetadata(undefined, mid);
  expect(r.convertedValues).toBe(0);
  expect(Object.keys(r.metadata)).toEqual([]);
});

test("normalizeModelMetadata: preserves strings, counts conversions", () => {
  const r = normalizeModelMetadata(
    { tier: "gold", n: 3, flag: true, nested: { a: 1 } },
    mid,
  );
  expect(r.metadata.tier).toBe("gold");
  expect(r.metadata.n).toBe("3");
  expect(r.metadata.flag).toBe("true");
  expect(r.metadata.nested).toBe('{"a":1}');
  expect(r.convertedValues).toBe(3);
});

test("normalizeModelMetadata: keeps original keys (no rekey/trim)", () => {
  const r = normalizeModelMetadata({ "  spaced  ": 1 }, mid);
  expect(r.metadata["  spaced  "]).toBe("1");
});

test("normalizeModelMetadata: __proto__ key round-trips (not dropped by setter)", () => {
  const input = Object.create(null) as Record<string, unknown>;
  setOwnString(input as Record<string, string>, "__proto__", "v");
  setOwnString(input as Record<string, string>, "tier", "gold");

  const r = normalizeModelMetadata(input, mid);
  expect(Object.prototype.hasOwnProperty.call(r.metadata, "__proto__")).toBe(true);
  expect(r.metadata["__proto__"]).toBe("v");
  expect(r.metadata.tier).toBe("gold");
});

test("normalizeModelMetadata: top-level Date/Map/RegExp abort (not empty map)", () => {
  expect(() => normalizeModelMetadata(new Date(), mid)).toThrow(/non-plain|Date/);
  expect(() => normalizeModelMetadata(new Map(), mid)).toThrow(/non-plain|Map/);
  // RegExp own keys would become { lastIndex: "0" } without this guard
  expect(() => normalizeModelMetadata(/x/g, mid)).toThrow(/non-plain|RegExp/);
});

test("normalizeModelMetadata: aborts on non-object metadata", () => {
  expect(() => normalizeModelMetadata(null, mid)).toThrow(/malformed non-object/);
  expect(() => normalizeModelMetadata("x", mid)).toThrow(/malformed non-object/);
  expect(() => normalizeModelMetadata(1, mid)).toThrow(/malformed non-object/);
  expect(() => normalizeModelMetadata(["a"], mid)).toThrow(/malformed non-object/);
});

test("normalizeModelMetadata: aborts on unconvertible nested value with model id", () => {
  expect(() =>
    normalizeModelMetadata({ bad: new Date() }, mid),
  ).toThrow(new RegExp(mid.replace(/[()]/g, "\\$&")));
});

test("normalizeModelMetadata: aborts when result exceeds write entry limit", () => {
  const big: Record<string, string> = {};
  for (let i = 0; i < METADATA_MAX_ENTRIES + 1; i++) {
    big[`k${i}`] = "v";
  }
  expect(() => normalizeModelMetadata(big, mid)).toThrow(
    new RegExp(String(METADATA_MAX_ENTRIES)),
  );
});

test("normalizeModelMetadata: aborts when value exceeds write length limit", () => {
  expect(() =>
    normalizeModelMetadata(
      { long: "x".repeat(METADATA_VALUE_MAX_LEN + 1) },
      mid,
    ),
  ).toThrow(new RegExp(String(METADATA_VALUE_MAX_LEN)));
});
