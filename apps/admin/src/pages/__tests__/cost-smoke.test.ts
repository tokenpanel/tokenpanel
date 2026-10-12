import { test, expect } from "bun:test";
import { buildModelPayload, emptyForm } from "../models/model-form.ts";
import { modelCreateInput, type ModelEntryDoc } from "@tokenpanel/db";

/** Simulate the JSON wire round-trip the real API does (strips undefined). */
function viaJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// The reported bug: cost showed $0 because the model form never wrote a cost
// schedule onto the entry. This guards the admin half of the fix - that cost
// entered in the form lands on the primary entry AND survives the API's own
// create-input validation (so the server will actually persist it).
test("form cost -> primary entry cost, accepted by API create-input schema", () => {
  const form = {
    ...emptyForm(),
    aliasId: "claude-sonnet",
    displayName: "Claude Sonnet",
    currency: "USD",
    marginPercent: "50",
    costInputUnits: "3",
    costOutputUnits: "15",
    costCacheReadUnits: "0.3",
    inputUnits: "4.5",
    outputUnits: "22.5",
    firstProviderId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    firstUpstreamModelId: "claude-sonnet-4",
  };

  const built = buildModelPayload(form, true);
  expect(built.ok).toBe(true);
  if (!built.ok) return;

  // Must pass the API's own validation, or the server would reject/drop it.
  const wire = viaJson(built.payload);
  const parsed = modelCreateInput.safeParse(wire);
  expect(parsed.success).toBe(true);

  const entry = (wire.entries as ModelEntryDoc[])[0]!;
  expect(entry.cost).toEqual({
    inputMicrosPerMillion: 3_000_000,
    outputMicrosPerMillion: 15_000_000,
    cacheReadMicrosPerMillion: 300_000,
  });
  // Price is independent of cost (retail, what the customer pays).
  expect(wire.price).toEqual({
    inputMicrosPerMillion: 4_500_000,
    outputMicrosPerMillion: 22_500_000,
  });
});

test("no cost entered -> entry has no cost field (backward compatible)", () => {
  const form = {
    ...emptyForm(),
    aliasId: "free-model",
    displayName: "Free",
    currency: "USD",
    inputUnits: "1",
    outputUnits: "2",
    firstProviderId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    firstUpstreamModelId: "free",
  };
  const built = buildModelPayload(form, true);
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  const wire = viaJson(built.payload);
  const entry = (wire.entries as ModelEntryDoc[])[0]!;
  expect(entry.cost).toBeUndefined();
  expect(modelCreateInput.safeParse(wire).success).toBe(true);
});
