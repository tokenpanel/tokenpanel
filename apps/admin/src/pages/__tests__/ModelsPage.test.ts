import { test, expect } from "bun:test";
import {
  parseModalities,
  modalitiesToText,
  toInt,
  toPositiveInt,
  toNonNegInt,
  buildModelPayload,
  coerceMetadataValue,
  metadataToRows,
  rowsToMetadata,
  isValidMetadataKey,
  metadataRowFieldErrors,
  formFromModel,
  type MetadataRow,
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
    inputUnits: "300",
    outputUnits: "600",
    currency: "USD",
    marginBps: "0",
    firstProviderId: "p1",
    firstUpstreamModelId: "gpt-4o",
    metadataRows: [] as MetadataRow[],
    metadataSourceMalformed: false,
    metadataCorruptReason: null,
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

test("buildModelPayload: context optional — empty/zero/non-int omits context", () => {
  const r0 = buildModelPayload(validForm({ contextLimit: "0" }), true);
  expect(r0.ok).toBe(true);
  if (r0.ok) expect((r0.payload.limits as Record<string, unknown>).context).toBeUndefined();
  const rEmpty = buildModelPayload(validForm({ contextLimit: "" }), true);
  expect(rEmpty.ok).toBe(true);
  if (rEmpty.ok) expect((rEmpty.payload.limits as Record<string, unknown>).context).toBeUndefined();
  const rFloat = buildModelPayload(validForm({ contextLimit: "1.5" }), true);
  expect(rFloat.ok).toBe(true);
  if (rFloat.ok) expect((rFloat.payload.limits as Record<string, unknown>).context).toBeUndefined();
});

test("buildModelPayload: price not non-neg int → error", () => {
  expect(buildModelPayload(validForm({ inputUnits: "-1" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ inputUnits: "1.5" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ outputUnits: "" }), true).ok).toBe(false);
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

// ─── metadata helpers ──────────────────────────────────────────────────────

test("coerceMetadataValue: strings/primitives/objects", () => {
  expect(coerceMetadataValue("x")).toBe("x");
  expect(coerceMetadataValue(3)).toBe("3");
  expect(coerceMetadataValue(true)).toBe("true");
  expect(coerceMetadataValue(null)).toBe("null");
  expect(coerceMetadataValue({ a: 1 })).toBe('{"a":1}');
  expect(coerceMetadataValue([1, 2])).toBe("[1,2]");
});

test("metadataToRows: missing/empty → ok empty; maps entries with coercion", () => {
  expect(metadataToRows(undefined)).toEqual({ rows: [], corrupt: false });
  expect(metadataToRows({}).rows).toEqual([]);
  expect(metadataToRows({}).corrupt).toBe(false);
  const mapped = metadataToRows({ tier: "gold", n: 2 });
  expect(mapped.corrupt).toBe(false);
  expect(mapped.rows).toHaveLength(2);
  expect(mapped.rows.find((r) => r.key === "tier")?.value).toBe("gold");
  expect(mapped.rows.find((r) => r.key === "n")?.value).toBe("2");
  expect(mapped.rows.every((r) => r.id.length > 0)).toBe(true);
});

test("metadataToRows: null/array → corrupt (not silent empty overwrite)", () => {
  const n = metadataToRows(null);
  expect(n.corrupt).toBe(true);
  expect(n.rows).toEqual([]);
  const a = metadataToRows([1, 2] as never);
  expect(a.corrupt).toBe(true);
});

test("rowsToMetadata: blank unused row omitted; value-only needs name", () => {
  expect(
    rowsToMetadata([
      { id: "1", key: "", value: "" },
      { id: "2", key: "  tier  ", value: "gold" },
    ]),
  ).toEqual({ ok: true, metadata: { tier: "gold" } });
  expect(rowsToMetadata([{ id: "1", key: "", value: "x" }]).ok).toBe(false);
});

test("rowsToMetadata: empty value allowed; duplicates/reserved rejected", () => {
  expect(rowsToMetadata([{ id: "1", key: "k", value: "" }])).toEqual({
    ok: true,
    metadata: { k: "" },
  });
  expect(
    rowsToMetadata([
      { id: "1", key: "a", value: "1" },
      { id: "2", key: " a ", value: "2" },
    ]).ok,
  ).toBe(false);
  expect(rowsToMetadata([{ id: "1", key: "__proto__", value: "x" }]).ok).toBe(false);
  expect(rowsToMetadata([{ id: "1", key: "$set", value: "x" }]).ok).toBe(false);
});

test("rowsToMetadata: empty rows → empty object (clear)", () => {
  expect(rowsToMetadata([])).toEqual({ ok: true, metadata: {} });
});

test("isValidMetadataKey: dots ok; reserved/$/empty/CRLF not", () => {
  expect(isValidMetadataKey("a.b")).toBe(true);
  expect(isValidMetadataKey("")).toBe(false);
  expect(isValidMetadataKey("$x")).toBe(false);
  expect(isValidMetadataKey("constructor")).toBe(false);
  expect(isValidMetadataKey("a\nb")).toBe(false);
  expect(isValidMetadataKey("a\rb")).toBe(false);
});

test("metadataRowFieldErrors: per-field messages for a11y", () => {
  const rows = [
    { id: "1", key: "", value: "orphan" },
    { id: "2", key: "ok", value: "line1\nline2" },
  ];
  expect(metadataRowFieldErrors(rows[0]!, rows).key).toMatch(/required/i);
  expect(metadataRowFieldErrors(rows[1]!, rows).key).toBeUndefined();
  expect(metadataRowFieldErrors(rows[1]!, rows).value).toBeUndefined();
  expect(
    metadataRowFieldErrors({ id: "3", key: "x\ny", value: "v" }, rows).key,
  ).toMatch(/line breaks/i);
});

test("metadataRowFieldErrors: length uses normalized value (CR/CRLF → LF)", () => {
  // Raw length 2002, normalized length 1001 — must match API acceptance.
  const almost = "\r\n".repeat(1001);
  expect(almost.length).toBe(2002);
  expect(
    metadataRowFieldErrors({ id: "1", key: "n", value: almost }, []).value,
  ).toBeUndefined();
  // Normalized 2001 LF chars → reject
  const over = "\r\n".repeat(2001);
  expect(
    metadataRowFieldErrors({ id: "1", key: "n", value: over }, []).value,
  ).toMatch(/at most/i);
});

test("rowsToMetadata: normalizes CR/CRLF → LF (textarea contract)", () => {
  expect(
    rowsToMetadata([{ id: "1", key: "note", value: "a\r\nb\rc\nd" }]),
  ).toEqual({ ok: true, metadata: { note: "a\nb\nc\nd" } });
});

test("buildModelPayload: always includes metadata; rows → object", () => {
  const r = buildModelPayload(
    validForm({
      metadataRows: [
        { id: "1", key: "tier", value: "gold" },
        { id: "2", key: "", value: "" },
      ],
    }),
    false,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.payload.metadata).toEqual({ tier: "gold" });
});

test("buildModelPayload: no rows → metadata {}", () => {
  const r = buildModelPayload(validForm({ metadataRows: [] }), true);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.payload.metadata).toEqual({});
});

test("buildModelPayload: invalid metadata row → error, no write payload", () => {
  const r = buildModelPayload(
    validForm({ metadataRows: [{ id: "1", key: "", value: "orphan" }] }),
    false,
  );
  expect(r.ok).toBe(false);
});

test("buildModelPayload: corrupt source omits metadata on edit (preserve server map)", () => {
  const r = buildModelPayload(
    validForm({
      metadataSourceMalformed: true,
      metadataCorruptReason: "Stored metadata is null (expected an object).",
      metadataRows: [],
    }),
    false,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect("metadata" in r.payload).toBe(false);
});

test("buildModelPayload: corrupt source blocks create", () => {
  const r = buildModelPayload(
    validForm({
      metadataSourceMalformed: true,
      metadataCorruptReason: "bad",
    }),
    true,
  );
  expect(r.ok).toBe(false);
});

test("formFromModel: rehydrates metadata rows from model", () => {
  const f = formFromModel({
    _id: "m1",
    organizationId: "o1",
    aliasId: "my-gpt",
    displayName: "My GPT",
    entries: [],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 100 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputUnitsPerMillion: 0, outputUnitsPerMillion: 0 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: { tier: "gold", n: 1 },
    createdAt: "",
    updatedAt: "",
  } as never);
  expect(f.metadataSourceMalformed).toBe(false);
  expect(f.metadataRows).toHaveLength(2);
  expect(f.metadataRows.find((r) => r.key === "tier")?.value).toBe("gold");
  expect(f.metadataRows.find((r) => r.key === "n")?.value).toBe("1");
});

test("formFromModel: malformed metadata sets corrupt flag and empty rows", () => {
  const f = formFromModel({
    _id: "m1",
    organizationId: "o1",
    aliasId: "my-gpt",
    displayName: "My GPT",
    entries: [],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 100 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputUnitsPerMillion: 0, outputUnitsPerMillion: 0 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: null as never,
    createdAt: "",
    updatedAt: "",
  } as never);
  expect(f.metadataSourceMalformed).toBe(true);
  expect(f.metadataRows).toEqual([]);
  expect(f.metadataCorruptReason).toMatch(/null/i);
});