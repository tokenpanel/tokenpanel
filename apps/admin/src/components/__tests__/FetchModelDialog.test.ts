import { test, expect } from "bun:test";
import { formatPrice, buildKey, buildHaystack } from "../FetchModelDialog.tsx";

import type { FetchedModel, FetchedModelCost } from "../../api/catalog.ts";

type FetchedModelFixture = { [K in keyof Omit<FetchedModel, "cost">]?: FetchedModel[K] } & {
  cost?: FetchedModelCost;
};

function mkModel(over: Partial<FetchedModelFixture> = {}): FetchedModel {
  const base: FetchedModelFixture = {
    sourceId: "models-dev",
    upstreamModelId: "openai/gpt-5",
    displayName: "GPT-5",
    ...over,
  };
  return base as FetchedModel;
}

test("formatPrice: missing cost → 'no price'", () => {
  expect(formatPrice(mkModel())).toBe("no price");
  expect(formatPrice(mkModel({}))).toBe("no price");
});

test("formatPrice: USD cents rendered via integer-exact micros codec", () => {
  // 2.50 USD/M input, 10 USD/M output (catalog stores cents)
  expect(
    formatPrice(
      mkModel({ cost: { inputUnitsPerMillion: 250, outputUnitsPerMillion: 1000 } }),
    ),
  ).toBe("$2.5 / $10");
  expect(
    formatPrice(mkModel({ cost: { inputUnitsPerMillion: 0, outputUnitsPerMillion: 15 } })),
  ).toBe("$0 / $0.15");
});

test("buildKey: subProvider prefixed; blank when absent", () => {
  expect(buildKey(mkModel())).toBe("/openai/gpt-5");
  expect(buildKey(mkModel({ subProvider: "azure" }))).toBe("azure/openai/gpt-5");
  expect(buildKey(mkModel({ subProvider: "" }))).toBe("/openai/gpt-5");
});

test("buildHaystack: id + displayName + subProvider, lowercased", () => {
  expect(buildHaystack(mkModel({ displayName: "GPT-5 Mini" }))).toBe("openai/gpt-5 gpt-5 mini ");
  expect(buildHaystack(mkModel({ subProvider: "Azure" }))).toBe(
    "openai/gpt-5 gpt-5 azure",
  );
  // the search field the dialog filters against must contain the queryable parts
  expect(buildHaystack(mkModel({ subProvider: "Azure" }))).toContain("azure");
});
