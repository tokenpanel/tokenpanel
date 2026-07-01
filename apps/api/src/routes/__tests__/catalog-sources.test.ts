import { test, expect } from "bun:test";
import { mapModel } from "../../catalog-sources/models-dev.ts";
import { listSources, getSource, listModels, clearCache } from "../../catalog-sources/registry.ts";

test("mapModel: full model → maps all fields, cost usd*100 -> minor", () => {
  const m = mapModel("vercel", {
    id: "anthropic/claude-3-haiku",
    name: "Claude Haiku 3",
    attachment: true,
    reasoning: false,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 200000, output: 4096 },
    status: "deprecated",
    cost: { input: 0.25, output: 1.25, cache_read: 0.03, cache_write: 0.3 },
  });
  expect(m).not.toBeNull();
  if (!m) return;
  expect(m.sourceId).toBe("models-dev");
  expect(m.upstreamModelId).toBe("anthropic/claude-3-haiku");
  expect(m.displayName).toBe("Claude Haiku 3");
  expect(m.subProvider).toBe("vercel");
  expect(m.attachment).toBe(true);
  expect(m.reasoning).toBe(false);
  expect(m.toolCall).toBe(true);
  expect(m.temperature).toBe(true);
  expect(m.structuredOutput).toBeUndefined();
  expect(m.limits).toEqual({ context: 200000, output: 4096 });
  expect(m.modalities).toEqual({ input: ["text", "image", "pdf"], output: ["text"] });
  expect(m.status).toBe("deprecated");
  expect(m.cost).toBeDefined();
  if (m.cost) {
    expect(m.cost.inputMinorPerMillion).toBe(25);
    expect(m.cost.outputMinorPerMillion).toBe(125);
    expect(m.cost.cacheReadMinorPerMillion).toBe(3);
    expect(m.cost.cacheWriteMinorPerMillion).toBe(30);
  }
});

test("mapModel: missing id → null", () => {
  expect(mapModel("p", { name: "No ID" })).toBeNull();
});

test("mapModel: missing name → falls back to id", () => {
  const m = mapModel("p", { id: "foo/bar" });
  expect(m?.displayName).toBe("foo/bar");
});

test("mapModel: no cost → cost undefined", () => {
  const m = mapModel("p", { id: "foo/bar", name: "Foo" });
  expect(m?.cost).toBeUndefined();
});

test("mapModel: partial cost (only input+output) → no optional minors", () => {
  const m = mapModel("p", { id: "foo/bar", cost: { input: 1, output: 2 } });
  expect(m?.cost).toEqual({ inputMinorPerMillion: 100, outputMinorPerMillion: 200 });
});

test("mapModel: unknown status → undefined (no ga invention)", () => {
  const m = mapModel("p", { id: "foo/bar", status: "weird" });
  expect(m?.status).toBeUndefined();
});

test("mapModel: empty modalities → empty arrays", () => {
  const m = mapModel("p", { id: "foo/bar" });
  expect(m?.modalities).toEqual({ input: [], output: [] });
});

test("registry: built-in models-dev source registered + listed", () => {
  const items = listSources();
  expect(items.some((s) => s.id === "models-dev")).toBe(true);
  expect(getSource("models-dev")?.displayName).toBe("models.dev");
  expect(getSource("does-not-exist")).toBeUndefined();
});

test("registry: listModels unknown source → []", async () => {
  clearCache("nope");
  const out = await listModels("nope");
  expect(out).toEqual([]);
});
