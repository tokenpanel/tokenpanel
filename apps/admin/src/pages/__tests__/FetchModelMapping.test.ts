import { test, expect } from "bun:test";
import { slugifyModelId, formFromFetched, type FormState } from "../ModelsPage.tsx";
import type { FetchedModel } from "../../api/catalog.ts";

function baseForm(over: Partial<FormState> = {}): FormState {
  return {
    aliasId: "",
    displayName: "",
    description: "",
    reasoning: false,
    toolCall: false,
    structuredOutput: false,
    temperature: false,
    attachment: false,
    contextLimit: "",
    inputLimit: "",
    outputLimit: "",
    inputModalities: "text",
    outputModalities: "text",
    status: "none",
    inputMinor: "0",
    outputMinor: "0",
    currency: "USD",
    marginBps: "0",
    firstProviderId: "p1",
    firstUpstreamModelId: "",
    ...over,
  } as FormState;
}

function mkModel(over: Partial<FetchedModel> = {}): FetchedModel {
  return {
    sourceId: "models-dev",
    upstreamModelId: "openai/gpt-5",
    displayName: "GPT-5",
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    temperature: false,
    attachment: true,
    limits: { context: 400000, input: 272000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    status: "beta",
    cost: {
      inputMinorPerMillion: 300,
      outputMinorPerMillion: 1500,
    },
    ...over,
  } as FetchedModel;
}

test("slugifyModelId: lowercases, / -> -, strips non [a-z0-9_-]", () => {
  expect(slugifyModelId("openai/gpt-5")).toBe("openai-gpt-5");
  expect(slugifyModelId("Anthropic/Claude.Opus")).toBe("anthropic-claudeopus");
  expect(slugifyModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
});

test("formFromFetched: maps all fields, keeps currency/marginBps/firstProviderId", () => {
  const f = formFromFetched(mkModel(), baseForm({ currency: "EUR", marginBps: "100", firstProviderId: "p9" }));
  expect(f.aliasId).toBe("openai-gpt-5");
  expect(f.displayName).toBe("GPT-5");
  expect(f.reasoning).toBe(true);
  expect(f.toolCall).toBe(true);
  expect(f.structuredOutput).toBe(true);
  expect(f.temperature).toBe(false);
  expect(f.attachment).toBe(true);
  expect(f.contextLimit).toBe("400000");
  expect(f.inputLimit).toBe("272000");
  expect(f.outputLimit).toBe("128000");
  expect(f.inputModalities).toBe("text, image");
  expect(f.outputModalities).toBe("text");
  expect(f.status).toBe("beta");
  expect(f.inputMinor).toBe("300");
  expect(f.outputMinor).toBe("1500");
  expect(f.firstUpstreamModelId).toBe("openai/gpt-5");
  // preserved from base
  expect(f.currency).toBe("EUR");
  expect(f.marginBps).toBe("100");
  expect(f.firstProviderId).toBe("p9");
});

test("formFromFetched: no cost → keeps base price", () => {
  const m = mkModel();
  delete m.cost;
  const f = formFromFetched(m, baseForm({ inputMinor: "5", outputMinor: "9" }));
  expect(f.inputMinor).toBe("5");
  expect(f.outputMinor).toBe("9");
});

test("formFromFetched: missing optional caps default false, status undefined -> none", () => {
  const m = mkModel();
  delete m.structuredOutput;
  delete m.status;
  const f = formFromFetched(m, baseForm());
  expect(f.structuredOutput).toBe(false);
  expect(f.status).toBe("none");
});

test("formFromFetched: non-positive limits fall back to base", () => {
  const m = mkModel({ limits: { context: 0 } });
  const f = formFromFetched(m, baseForm({ contextLimit: "128000", inputLimit: "", outputLimit: "" }));
  expect(f.contextLimit).toBe("128000");
});

test("formFromFetched: empty modalities fall back to base", () => {
  const m = mkModel({ modalities: { input: [], output: [] } });
  const f = formFromFetched(m, baseForm({ inputModalities: "text", outputModalities: "text, audio" }));
  expect(f.inputModalities).toBe("text");
  expect(f.outputModalities).toBe("text, audio");
});
