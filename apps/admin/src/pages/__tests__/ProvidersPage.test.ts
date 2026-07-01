import { test, expect } from "bun:test";
import { isUrl, fromProvider } from "../ProvidersPage.tsx";

test("isUrl: valid http/https → true", () => {
  expect(isUrl("https://api.openai.com/v1")).toBe(true);
  expect(isUrl("http://localhost:3000")).toBe(true);
});

test("isUrl: invalid scheme → false", () => {
  expect(isUrl("ftp://x.com")).toBe(false);
  expect(isUrl("file:///etc/passwd")).toBe(false);
});

test("isUrl: malformed → false", () => {
  expect(isUrl("not-a-url")).toBe(false);
  expect(isUrl("")).toBe(false);
  expect(isUrl("http://")).toBe(false);
});

test("fromProvider: maps fields, empty apiKey, headers JSON-stringified when present", () => {
  const p = {
    _id: "x",
    organizationId: "o",
    name: "OpenAI",
    sdkType: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    providerOrg: "org-1",
    headers: { "X-H": "v" },
    active: true,
    metadata: {},
    hasApiKey: true,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  } as never;
  const f = fromProvider(p);
  expect(f.name).toBe("OpenAI");
  expect(f.sdkType).toBe("openai-compatible");
  expect(f.apiKey).toBe("");
  expect(f.baseUrl).toBe("https://api.openai.com/v1");
  expect(f.providerOrg).toBe("org-1");
  expect(f.headers).toBe(JSON.stringify({ "X-H": "v" }, null, 2));
});

test("fromProvider: empty headers → empty string (not 'null' or '{}')", () => {
  const p = {
    _id: "x",
    organizationId: "o",
    name: "X",
    sdkType: "openai-compatible",
    baseUrl: "https://x.com",
    providerOrg: undefined,
    headers: {},
    active: true,
    metadata: {},
    hasApiKey: true,
    createdAt: "",
    updatedAt: "",
  } as never;
  const f = fromProvider(p);
  expect(f.headers).toBe("");
  expect(f.providerOrg).toBe("");
});