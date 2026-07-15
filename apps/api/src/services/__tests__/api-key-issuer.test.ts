import { test, expect } from "bun:test";
import {
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
  API_KEY_LOOKUP_PREFIX_CHARS,
  issueCustomerApiKeyMaterial,
  issueManagementApiKeyMaterial,
  issueApiKeyWithRetry,
} from "../api-key-issuer.ts";
import { hashToken } from "../../lib/crypto.ts";

test("customer material: tp_live_ prefix, 16-char lookup prefix, hash matches", () => {
  const k = issueCustomerApiKeyMaterial();
  expect(k.fullKey.startsWith(CUSTOMER_KEY_PREFIX_LITERAL)).toBe(true);
  expect(k.prefix).toBe(k.fullKey.slice(0, API_KEY_LOOKUP_PREFIX_CHARS));
  expect(k.prefix.length).toBe(API_KEY_LOOKUP_PREFIX_CHARS);
  expect(k.keyHash).toBe(hashToken(k.fullKey));
});

test("management material: tp_mgmt_ prefix, mutually exclusive with customer", () => {
  const k = issueManagementApiKeyMaterial();
  expect(k.fullKey.startsWith(MANAGEMENT_KEY_PREFIX_LITERAL)).toBe(true);
  expect(k.fullKey.startsWith(CUSTOMER_KEY_PREFIX_LITERAL)).toBe(false);
  expect(k.prefix.length).toBe(API_KEY_LOOKUP_PREFIX_CHARS);
});

test("issueApiKeyWithRetry: succeeds on first insert", async () => {
  const r = await issueApiKeyWithRetry({
    literal: CUSTOMER_KEY_PREFIX_LITERAL,
    insert: async () => {
      /* ok */
    },
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.issued.fullKey.startsWith("tp_live_")).toBe(true);
  }
});

test("issueApiKeyWithRetry: retries confirmed duplicate then succeeds", async () => {
  let n = 0;
  const r = await issueApiKeyWithRetry({
    literal: CUSTOMER_KEY_PREFIX_LITERAL,
    maxAttempts: 5,
    insert: async () => {
      n += 1;
      if (n < 3) {
        const err = new Error("E11000 duplicate key");
        (err as { code?: number; name?: string }).code = 11000;
        (err as { name?: string }).name = "MongoServerError";
        throw err;
      }
    },
  });
  expect(r.ok).toBe(true);
  expect(n).toBe(3);
});

test("issueApiKeyWithRetry: exhausts on repeated duplicates", async () => {
  const r = await issueApiKeyWithRetry({
    literal: CUSTOMER_KEY_PREFIX_LITERAL,
    maxAttempts: 2,
    insert: async () => {
      const err = new Error("E11000 duplicate key");
      (err as { code?: number }).code = 11000;
      throw err;
    },
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("prefix_exhausted");
});

test("issueApiKeyWithRetry: does not retry non-duplicate errors", async () => {
  await expect(
    issueApiKeyWithRetry({
      literal: CUSTOMER_KEY_PREFIX_LITERAL,
      insert: async () => {
        throw new Error("network blip");
      },
    }),
  ).rejects.toThrow(/network blip/);
});
