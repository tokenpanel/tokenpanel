import { test, expect } from "bun:test";
import {
  MODEL_MODALITIES,
  MODEL_STATUSES,
  MODEL_METADATA_POLICY,
  MODEL_METADATA_RESERVED_KEYS,
  modelModalitySchema,
  modelStatusSchema,
  isValidModelMetadataKey,
  isReservedModelMetadataKey,
  normalizeMetadataValueNewlines,
} from "../model.ts";

test("MODEL_MODALITIES matches known product set", () => {
  expect([...MODEL_MODALITIES]).toEqual([
    "text",
    "image",
    "audio",
    "video",
    "pdf",
  ]);
  expect(modelModalitySchema.safeParse("text").success).toBe(true);
  expect(modelModalitySchema.safeParse("unknown").success).toBe(false);
});

test("MODEL_STATUSES matches known product set", () => {
  expect([...MODEL_STATUSES]).toEqual([
    "alpha",
    "beta",
    "deprecated",
    "ga",
  ]);
  expect(modelStatusSchema.safeParse("ga").success).toBe(true);
  expect(modelStatusSchema.safeParse("preview").success).toBe(false);
});

test("MODEL_METADATA_POLICY limits", () => {
  expect(MODEL_METADATA_POLICY.maxEntries).toBe(50);
  expect(MODEL_METADATA_POLICY.keyMaxLen).toBe(80);
  expect(MODEL_METADATA_POLICY.valueMaxLen).toBe(2000);
  expect([...MODEL_METADATA_RESERVED_KEYS]).toEqual([
    "__proto__",
    "prototype",
    "constructor",
  ]);
});

test("isValidModelMetadataKey parity fixtures", () => {
  expect(isValidModelMetadataKey("vendor.note")).toBe(true);
  expect(isValidModelMetadataKey("x".repeat(80))).toBe(true);
  expect(isValidModelMetadataKey("")).toBe(false);
  expect(isValidModelMetadataKey("x".repeat(81))).toBe(false);
  expect(isValidModelMetadataKey("a\0b")).toBe(false);
  expect(isValidModelMetadataKey("a\nb")).toBe(false);
  expect(isValidModelMetadataKey("a\rb")).toBe(false);
  expect(isValidModelMetadataKey("$set")).toBe(false);
  for (const k of MODEL_METADATA_RESERVED_KEYS) {
    expect(isValidModelMetadataKey(k)).toBe(false);
    expect(isReservedModelMetadataKey(k)).toBe(true);
  }
});

test("normalizeMetadataValueNewlines: CRLF and CR → LF", () => {
  expect(normalizeMetadataValueNewlines("a\r\nb\rc")).toBe("a\nb\nc");
  expect(normalizeMetadataValueNewlines("plain")).toBe("plain");
});
