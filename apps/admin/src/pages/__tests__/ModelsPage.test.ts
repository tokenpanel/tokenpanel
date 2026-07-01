import { test, expect } from "bun:test";
import {
  parseModalities,
  modalitiesToText,
  toInt,
  toPositiveInt,
  toNonNegInt,
  buildModelPayload,
} from "../ModelsPage.tsx";

test("parseModalities: splits comma, lowercases, filters unknown, dedupes", () => {
  expect(parseModalities("text, image, TEXT, audio, bogus")).toEqual(["text", "image", "audio"]);
  expect(parseModalities("")).toEqual([]);
  expect(parseModalities("TEXT")).toEqual(["text"]);
});

test("modalitiesToText: joins with comma+space", () => {
  expect(modalitiesToText(["text", "image"])).toBe("text, image");
  expect(modalitiesToText([])).toBe("");
});

test("toInt: empty → undefined; float → undefined; valid int → n", () => {
  expect(toInt("")).toBeUndefined();
  expect(toInt("  ")).toBeUndefined();
  expect(toInt("1.5")).toBeUndefined();
  expect(toInt("abc")).toBeUndefined();
  expect(toInt("100")).toBe(100);
  expect(toInt("-5")).toBe(-5);
});

test("toPositiveInt: empty/zero/negative/float → undefined; positive int → n", () => {
  expect(toPositiveInt("")).toBeUndefined();
  expect(toPositiveInt("0")).toBeUndefined();
  expect(toPositiveInt("-1")).toBeUndefined();
  expect(toPositiveInt("1.5")).toBeUndefined();
  expect(toPositiveInt("128000")).toBe(128000);
});

test("toNonNegInt: empty/negative/float → undefined; zero+ → n", () => {
  expect(toNonNegInt("")).toBeUndefined();
  expect(toNonNegInt("-1")).toBeUndefined();
  expect(toNonNegInt("1.5")).toBeUndefined();
  expect(toNonNegInt("0")).toBe(0);
  expect(toNonNegInt("100")).toBe(100);
});

function validForm(over: Record<string, unknown> = {}) {
  return {
    aliasId: "my-gpt",
    displayName: "My GPT",
    description: "",
    reasoning: false,
    toolCall: false,
    structuredOutput: false,
    temperature: false,
    attachment: false,
    contextLimit: "128000",
    inputLimit: "",
    outputLimit: "",
    inputModalities: "text",
    outputModalities: "text",
    status: "none",
    inputMinor: "300",
    outputMinor: "600",
    currency: "USD",
    marginBps: "0",
    firstProviderId: "p1",
    firstUpstreamModelId: "gpt-4o",
    ...over,
  } as never;
}

test("buildModelPayload: valid create → ok payload with entries", () => {
  const r = buildModelPayload(validForm(), true);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.payload.aliasId).toBe("my-gpt");
    expect(r.payload.entries).toEqual([{ providerId: "p1", upstreamModelId: "gpt-4o", priority: 0, active: true }]);
    expect(r.payload.limits).toEqual({ context: 128000 });
  }
});

test("buildModelPayload: valid edit (isCreate=false) → no entries field", () => {
  const r = buildModelPayload(validForm(), false);
  expect(r.ok).toBe(true);
  if (r.ok) expect("entries" in r.payload).toBe(false);
});

test("buildModelPayload: empty aliasId → error", () => {
  expect(buildModelPayload(validForm({ aliasId: "" }), true).ok).toBe(false);
});

test("buildModelPayload: bad aliasId regex → error", () => {
  expect(buildModelPayload(validForm({ aliasId: "MY-GPT" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ aliasId: "my.gpt" }), true).ok).toBe(false);
});

test("buildModelPayload: empty displayName → error", () => {
  expect(buildModelPayload(validForm({ displayName: "" }), true).ok).toBe(false);
});

test("buildModelPayload: context not positive int → error", () => {
  expect(buildModelPayload(validForm({ contextLimit: "0" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ contextLimit: "" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ contextLimit: "1.5" }), true).ok).toBe(false);
});

test("buildModelPayload: price not non-neg int → error", () => {
  expect(buildModelPayload(validForm({ inputMinor: "-1" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ inputMinor: "1.5" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ outputMinor: "" }), true).ok).toBe(false);
});

test("buildModelPayload: margin not non-neg int → error", () => {
  expect(buildModelPayload(validForm({ marginBps: "-1" }), true).ok).toBe(false);
});

test("buildModelPayload: currency not 3-letter → error", () => {
  expect(buildModelPayload(validForm({ currency: "US" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ currency: "USDD" }), true).ok).toBe(false);
});

test("buildModelPayload: create missing providerId → error", () => {
  expect(buildModelPayload(validForm({ firstProviderId: "" }), true).ok).toBe(false);
});

test("buildModelPayload: create missing upstreamModelId → error", () => {
  expect(buildModelPayload(validForm({ firstUpstreamModelId: "" }), true).ok).toBe(false);
});

test("buildModelPayload: status none → undefined in payload", () => {
  const r = buildModelPayload(validForm({ status: "none" }), false);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.payload.status).toBeUndefined();
});

test("buildModelPayload: status ga → included in payload", () => {
  const r = buildModelPayload(validForm({ status: "ga" }), false);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.payload.status).toBe("ga");
});

test("buildModelPayload: optional input/output limits included when valid positive int", () => {
  const r = buildModelPayload(validForm({ inputLimit: "127000", outputLimit: "4096" }), false);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.payload.limits).toEqual({ context: 128000, input: 127000, output: 4096 });
});

test("buildModelPayload: empty description → undefined in payload", () => {
  const r = buildModelPayload(validForm({ description: "" }), false);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.payload.description).toBeUndefined();
});

test("buildModelPayload: modalities parsed from comma string", () => {
  const r = buildModelPayload(validForm({ inputModalities: "text, image", outputModalities: "audio" }), false);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.payload.modalities).toEqual({ input: ["text", "image"], output: ["audio"] });
});