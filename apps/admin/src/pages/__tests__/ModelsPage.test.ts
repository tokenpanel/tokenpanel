import { test, expect } from "bun:test";
import {
  parseModalities,
  modalitiesToText,
  toInt,
  toPositiveInt,
  toNonNegInt,
  buildModelPayload,
  priceFromCostMargin,
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
    reasoningUnits: "",
    cacheReadUnits: "",
    cacheWriteUnits: "",
    inputAudioUnits: "",
    outputAudioUnits: "",
    costInputUnits: "",
    costOutputUnits: "",
    costReasoningUnits: "",
    costCacheReadUnits: "",
    costCacheWriteUnits: "",
    costInputAudioUnits: "",
    costOutputAudioUnits: "",
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

test("buildModelPayload: aliasId allows dots but rejects uppercase", () => {
  expect(buildModelPayload(validForm({ aliasId: "gpt-5.6-luna" }), true).ok).toBe(true);
  expect(buildModelPayload(validForm({ aliasId: "MY-GPT" }), true).ok).toBe(false);
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

test("buildModelPayload: price not non-neg decimal → error", () => {
  expect(buildModelPayload(validForm({ inputUnits: "-1" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ inputUnits: "abc" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ outputUnits: "" }), true).ok).toBe(false);
});

test("buildModelPayload: optional rates included when set, omitted when blank", () => {
  const withRates = buildModelPayload(
    validForm({ cacheReadUnits: "30", cacheWriteUnits: "375", reasoningUnits: "900" }),
    true,
  );
  expect(withRates.ok).toBe(true);
  if (withRates.ok) {
    expect(withRates.payload.price).toEqual({
      inputMicrosPerMillion: 300_000_000,
      outputMicrosPerMillion: 600_000_000,
      cacheReadMicrosPerMillion: 30_000_000,
      cacheWriteMicrosPerMillion: 375_000_000,
      reasoningMicrosPerMillion: 900_000_000,
    });
  }
  const blank = buildModelPayload(validForm({ cacheReadUnits: "  " }), true);
  expect(blank.ok).toBe(true);
  if (blank.ok) {
    expect(blank.payload.price).toEqual({ inputMicrosPerMillion: 300_000_000, outputMicrosPerMillion: 600_000_000 });
  }
});

test("buildModelPayload: optional rate not non-neg decimal → error", () => {
  expect(buildModelPayload(validForm({ cacheReadUnits: "-5" }), true).ok).toBe(false);
  expect(buildModelPayload(validForm({ reasoningUnits: "abc" }), true).ok).toBe(false);
});

test("buildModelPayload: margin not non-neg int → error; blank → 0", () => {
  expect(buildModelPayload(validForm({ marginBps: "-1" }), true).ok).toBe(false);
  const blank = buildModelPayload(validForm({ marginBps: "" }), true);
  expect(blank.ok).toBe(true);
  if (blank.ok) expect(blank.payload.marginBps).toBe(0);
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
    price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
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
    price: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
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

test("priceFromCostMargin: integer-exact markup, ceil'd so margin never undercut", () => {
  // 50% of $1.00/M = $1.50/M.
  expect(priceFromCostMargin("1", "5000")).toBe("1.5");
  // 100 bps (1%) of $1.00/M = $1.01/M.
  expect(priceFromCostMargin("1", "100")).toBe("1.01");
  // 0 margin → price equals cost.
  expect(priceFromCostMargin("2.5", "0")).toBe("2.5");
  // Markup that lands on a sub-micro boundary is ceil'd up, never down:
  // $0.000001/M cost × 1 bps = 0.0000000001 → ceil → 1 micro → $0.000002/M.
  expect(priceFromCostMargin("0.000001", "1")).toBe("0.000002");
});

test("priceFromCostMargin: blank cost or bad margin → undefined (field unchanged)", () => {
  expect(priceFromCostMargin("", "5000")).toBeUndefined();
  expect(priceFromCostMargin("  ", "5000")).toBeUndefined();
  expect(priceFromCostMargin("1", "abc")).toBeUndefined();
  expect(priceFromCostMargin("1", "-5")).toBeUndefined();
  expect(priceFromCostMargin("not-a-number", "100")).toBeUndefined();
});

test("buildModelPayload: create with cost → primary entry carries cost schedule", () => {
  const r = buildModelPayload(
    validForm({ costInputUnits: "1", costOutputUnits: "2", costCacheReadUnits: "0.1" }),
    true,
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.payload.entries).toEqual([
      {
        providerId: "p1",
        upstreamModelId: "gpt-4o",
        priority: 0,
        active: true,
        cost: {
          inputMicrosPerMillion: 1_000_000,
          outputMicrosPerMillion: 2_000_000,
          cacheReadMicrosPerMillion: 100_000,
        },
      },
    ]);
  }
});

test("buildModelPayload: create with no cost → primary entry has no cost field", () => {
  const r = buildModelPayload(validForm(), true);
  expect(r.ok).toBe(true);
  if (r.ok) {
    const entry = (r.payload.entries as Array<Record<string, unknown>>)[0]!;
    expect("cost" in entry).toBe(false);
  }
});

test("buildModelPayload: cost input/output required before optional cost rates", () => {
  const r = buildModelPayload(validForm({ costCacheReadUnits: "0.1" }), true);
  expect(r.ok).toBe(false);
});

test("buildModelPayload: edit merges cost into primary entry, preserves others", () => {
  const existing = {
    entries: [
      { id: "e1", providerId: "p1", upstreamModelId: "gpt-4o", priority: 0, active: true },
      {
        id: "e2",
        providerId: "p2",
        upstreamModelId: "claude",
        priority: 1,
        active: true,
        cost: { inputMicrosPerMillion: 999, outputMicrosPerMillion: 888 },
        price: { inputMicrosPerMillion: 111, outputMicrosPerMillion: 222 },
      },
    ],
  } as never;
  const r = buildModelPayload(validForm({ costInputUnits: "1", costOutputUnits: "2" }), false, existing);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.payload.entries).toEqual([
      {
        id: "e1",
        providerId: "p1",
        upstreamModelId: "gpt-4o",
        priority: 0,
        active: true,
        cost: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 },
      },
      {
        id: "e2",
        providerId: "p2",
        upstreamModelId: "claude",
        priority: 1,
        active: true,
        cost: { inputMicrosPerMillion: 999, outputMicrosPerMillion: 888 },
        price: { inputMicrosPerMillion: 111, outputMicrosPerMillion: 222 },
      },
    ]);
  }
});

test("formFromModel: rehydrates cost fields from primary entry", () => {
  const f = formFromModel({
    _id: "m1",
    organizationId: "o1",
    aliasId: "my-gpt",
    displayName: "My GPT",
    entries: [
      {
        id: "e1",
        providerId: "p1",
        upstreamModelId: "gpt-4o",
        priority: 0,
        active: true,
        cost: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_500_000 },
      },
    ],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: { context: 100 },
    modalities: { input: ["text"], output: ["text"] },
    price: { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 6_000_000 },
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: "",
    updatedAt: "",
  } as never);
  expect(f.costInputUnits).toBe("1");
  expect(f.costOutputUnits).toBe("2.5");
  // price fields come from model.price, independent of cost
  expect(f.inputUnits).toBe("3");
  expect(f.outputUnits).toBe("6");
});