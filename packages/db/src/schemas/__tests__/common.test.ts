import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  objectId,
  objectIdFromString,
  currencyCode,
  moneyUnits,
  tokenCount,
  money,
  customerBalance,
  tokenPriceSchedule,
  tokenLimits,
  modalitySchema,
  modalities,
  modelStatus,
  modelCapabilities,
} from "../common.ts";

test("objectId accepts ObjectId instances, rejects strings", () => {
  const id = new ObjectId();
  expect(objectId.safeParse(id).success).toBe(true);
  expect(objectId.safeParse("abc").success).toBe(false);
  expect(objectId.safeParse(123).success).toBe(false);
  expect(objectId.safeParse(null).success).toBe(false);
});

test("objectIdFromString coerces valid 24-hex strings to ObjectId", () => {
  const hex = "507f1f77bcf86cd799439011";
  const r = objectIdFromString.safeParse(hex);
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data).toBeInstanceOf(ObjectId);
    expect(r.data.toHexString()).toBe(hex);
  }
});

test("objectIdFromString rejects invalid strings", () => {
  expect(objectIdFromString.safeParse("not-an-id").success).toBe(false);
  expect(objectIdFromString.safeParse("").success).toBe(false);
  expect(objectIdFromString.safeParse("507f1f77bcf86cd79943901").success).toBe(false);
  expect(objectIdFromString.safeParse("507f1f77bcf86cd7994390111").success).toBe(false);
  expect(objectIdFromString.safeParse("abcdefghijkl").success).toBe(false);
});

test("currencyCode enforces 3 uppercase letters; regex blocks lowercase before transform", () => {
  expect(currencyCode.safeParse("USD").success).toBe(true);
  expect(currencyCode.safeParse("usd").success).toBe(false);
  expect(currencyCode.safeParse("US").success).toBe(false);
  expect(currencyCode.safeParse("USDD").success).toBe(false);
  expect(currencyCode.safeParse("12").success).toBe(false);
  expect(currencyCode.safeParse("").success).toBe(false);
});

test("moneyUnits accepts non-negative ints, rejects negatives/floats/NaN", () => {
  expect(moneyUnits.safeParse(0).success).toBe(true);
  expect(moneyUnits.safeParse(100).success).toBe(true);
  expect(moneyUnits.safeParse(-1).success).toBe(false);
  expect(moneyUnits.safeParse(1.5).success).toBe(false);
  expect(moneyUnits.safeParse(NaN).success).toBe(false);
  expect(moneyUnits.safeParse(Infinity).success).toBe(false);
  expect(moneyUnits.safeParse("100").success).toBe(false);
});

test("tokenCount accepts safe non-negative ints, rejects unsafe/overflow values", () => {
  expect(tokenCount.safeParse(0).success).toBe(true);
  expect(tokenCount.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
  expect(tokenCount.safeParse(-1).success).toBe(false);
  expect(tokenCount.safeParse(1.5).success).toBe(false);
  expect(tokenCount.safeParse(Infinity).success).toBe(false);
  // Beyond MAX_SAFE_INTEGER is not a safe integer representable distinctly.
  expect(tokenCount.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
});

test("money object requires amountUnits + currency", () => {
  expect(money.safeParse({ amountUnits: 100, currency: "USD" }).success).toBe(true);
  expect(money.safeParse({ amountUnits: 100 }).success).toBe(false);
  expect(money.safeParse({ amountUnits: -1, currency: "USD" }).success).toBe(false);
  expect(money.safeParse({ amountUnits: 100, currency: "us" }).success).toBe(false);
});

test("customerBalance defaults reservedUnits to 0", () => {
  const r = customerBalance.parse({ amountUnits: 100, currency: "USD" });
  expect(r.reservedUnits).toBe(0);
  expect(
    customerBalance.safeParse({
      amountUnits: 100,
      reservedUnits: 25,
      currency: "USD",
    }).success,
  ).toBe(true);
});

test("tokenPriceSchedule requires input+output, optional rest", () => {
  expect(
    tokenPriceSchedule.safeParse({
      inputUnitsPerMillion: 300,
      outputUnitsPerMillion: 600,
    }).success,
  ).toBe(true);
  expect(
    tokenPriceSchedule.safeParse({
      inputUnitsPerMillion: 300,
      outputUnitsPerMillion: 600,
      reasoningUnitsPerMillion: 900,
      cacheReadUnitsPerMillion: 30,
      cacheWriteUnitsPerMillion: 40,
    }).success,
  ).toBe(true);
  expect(tokenPriceSchedule.safeParse({ inputUnitsPerMillion: 300 }).success).toBe(false);
  expect(
    tokenPriceSchedule.safeParse({
      inputUnitsPerMillion: -1,
      outputUnitsPerMillion: 600,
    }).success,
  ).toBe(false);
  expect(
    tokenPriceSchedule.safeParse({
      inputUnitsPerMillion: 1.5,
      outputUnitsPerMillion: 600,
    }).success,
  ).toBe(false);
});

test("tokenLimits requires positive context, optional positive input/output", () => {
  expect(tokenLimits.safeParse({ context: 128000 }).success).toBe(true);
  expect(tokenLimits.safeParse({ context: 128000, input: 127000, output: 4096 }).success).toBe(true);
  expect(tokenLimits.safeParse({ context: 0 }).success).toBe(false);
  expect(tokenLimits.safeParse({ context: -1 }).success).toBe(false);
  expect(tokenLimits.safeParse({ context: 128000, input: 0 }).success).toBe(false);
  expect(tokenLimits.safeParse({}).success).toBe(false);
});

test("modalitySchema only accepts known modalities", () => {
  for (const m of ["text", "image", "audio", "video", "pdf"]) {
    expect(modalitySchema.safeParse(m).success).toBe(true);
  }
  expect(modalitySchema.safeParse("TEXT").success).toBe(false);
  expect(modalitySchema.safeParse("html").success).toBe(false);
  expect(modalitySchema.safeParse("").success).toBe(false);
});

test("modalities requires input+output arrays", () => {
  expect(modalities.safeParse({ input: ["text"], output: ["text"] }).success).toBe(true);
  expect(modalities.safeParse({ input: ["text", "image"], output: ["text"] }).success).toBe(true);
  expect(modalities.safeParse({ input: ["text"] }).success).toBe(false);
  expect(modalities.safeParse({ input: ["bogus"], output: ["text"] }).success).toBe(false);
});

test("modelStatus accepts known statuses", () => {
  for (const s of ["alpha", "beta", "deprecated", "ga"]) {
    expect(modelStatus.safeParse(s).success).toBe(true);
  }
  expect(modelStatus.safeParse("GA").success).toBe(false);
  expect(modelStatus.safeParse("stable").success).toBe(false);
});

test("modelCapabilities applies defaults; interleaved absent → undefined", () => {
  const r = modelCapabilities.parse({});
  expect(r.reasoning).toBe(false);
  expect(r.toolCall).toBe(false);
  expect(r.attachment).toBe(false);
  expect(r.interleaved).toBeUndefined();
  expect(r.structuredOutput).toBeUndefined();
});

test("modelCapabilities accepts interleaved field variants", () => {
  expect(
    modelCapabilities.safeParse({ reasoning: true, interleaved: { field: "reasoning_content" } }).success,
  ).toBe(true);
  expect(
    modelCapabilities.safeParse({ reasoning: true, interleaved: { field: "reasoning_details" } }).success,
  ).toBe(true);
  expect(
    modelCapabilities.safeParse({ reasoning: true, interleaved: { field: "other" } }).success,
  ).toBe(false);
});