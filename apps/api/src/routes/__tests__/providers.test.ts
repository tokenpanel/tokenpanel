import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { maskProvider, parseObjectIdParam } from "../providers.ts";
import type { ProviderDoc } from "@tokenpanel/db";

function doc(over: Partial<ProviderDoc> = {}): ProviderDoc {
  return {
    _id: new ObjectId(),
    organizationId: new ObjectId(),
    name: "OpenAI",
    sdkType: "openai-compatible",
    apiKeyEncrypted: "enc-string",
    baseUrl: "https://api.openai.com/v1",
    providerOrg: null,
    headers: {},
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

test("maskProvider: removes apiKeyEncrypted, adds hasApiKey true, preserves other fields", () => {
  const m = maskProvider(doc());
  expect("apiKeyEncrypted" in m).toBe(false);
  expect(m.hasApiKey).toBe(true);
  expect(m.name).toBe("OpenAI");
  expect(m.baseUrl).toBe("https://api.openai.com/v1");
  expect(m.sdkType).toBe("openai-compatible");
});

test("maskProvider: preserves providerOrg + metadata; redacts header values to true", () => {
  const m = maskProvider(doc({ providerOrg: "org-1", headers: { "X-H": "v" }, metadata: { k: 1 } }));
  expect(m.providerOrg).toBe("org-1");
  expect(m.headers).toEqual({ "X-H": true });
  expect(m.metadata).toEqual({ k: 1 });
});

test("parseObjectIdParam: valid → ObjectId, invalid → null", () => {
  const hex = new ObjectId().toHexString();
  expect(parseObjectIdParam(hex)).toBeInstanceOf(ObjectId);
  expect(parseObjectIdParam("bad")).toBeNull();
});