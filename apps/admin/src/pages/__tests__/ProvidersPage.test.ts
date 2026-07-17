import { test, expect } from "bun:test";
import {
  fromProvider,
  parseHttpTimeoutMsInput,
} from "../ProvidersPage.tsx";

test("fromProvider maps httpTimeoutMs number to string; null/absent → empty", () => {
  const base = {
    _id: "p1",
    organizationId: "o1",
    name: "OpenAI",
    sdkType: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    headers: {},
    active: true,
    metadata: {},
    hasApiKey: true as const,
    createdAt: "",
    updatedAt: "",
  };
  expect(fromProvider({ ...base, httpTimeoutMs: 120_000 }).httpTimeoutMs).toBe(
    "120000",
  );
  expect(fromProvider({ ...base, httpTimeoutMs: 0 }).httpTimeoutMs).toBe("0");
  expect(fromProvider({ ...base, httpTimeoutMs: null }).httpTimeoutMs).toBe("");
  expect(fromProvider(base).httpTimeoutMs).toBe("");
});

test("parseHttpTimeoutMsInput: empty inherits; 0 and positive ok; rejects bad", () => {
  expect(parseHttpTimeoutMsInput("")).toEqual({ ok: true, value: undefined });
  expect(parseHttpTimeoutMsInput("  ")).toEqual({ ok: true, value: undefined });
  expect(parseHttpTimeoutMsInput("0")).toEqual({ ok: true, value: 0 });
  expect(parseHttpTimeoutMsInput("120000")).toEqual({
    ok: true,
    value: 120_000,
  });
  expect(parseHttpTimeoutMsInput("3600000").ok).toBe(true);
  expect(parseHttpTimeoutMsInput("3600001").ok).toBe(false);
  expect(parseHttpTimeoutMsInput("-1").ok).toBe(false);
  expect(parseHttpTimeoutMsInput("12.5").ok).toBe(false);
  expect(parseHttpTimeoutMsInput("abc").ok).toBe(false);
});
