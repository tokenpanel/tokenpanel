import { test, expect } from "bun:test";
import {
  MODEL_METADATA_RESERVED_KEYS,
  modelModalitySchema,
  modelStatusSchema,
  isValidModelMetadataKey,
  isReservedModelMetadataKey,
  normalizeMetadataValueNewlines,
} from "../index.ts";

test("model modality/status schemas reject unknown values", () => {
  expect(modelModalitySchema.safeParse("text").success).toBe(true);
  expect(modelModalitySchema.safeParse("unknown").success).toBe(false);
  expect(modelStatusSchema.safeParse("ga").success).toBe(true);
  expect(modelStatusSchema.safeParse("preview").success).toBe(false);
});

test("isValidModelMetadataKey rejects hostile / reserved keys", () => {
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
