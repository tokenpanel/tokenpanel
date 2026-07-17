import { hashToken, randomToken, isDuplicateKeyError } from "../lib/crypto.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT,
  API_KEY_SECRET_BYTES,
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "../config/security-policy.ts";

/**
 * Single owner for customer and management API-key material construction.
 * Format constants live in config/security-policy.ts (crypto-compatible).
 * Routes retain authorization, scopes, labels, collection writes, and response
 * envelopes. Format and hashing stay compatible with existing stored keys.
 */

export {
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
  API_KEY_LOOKUP_PREFIX_CHARS,
  API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT,
} from "../config/security-policy.ts";

/** Random secret material after the literal prefix (hex chars). */
export { API_KEY_SECRET_HEX_CHARS } from "../config/security-policy.ts";

/** Historical alias for collision attempts. */
export const API_KEY_PREFIX_COLLISION_ATTEMPTS =
  API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT;

export type IssuedApiKey = Readonly<{
  /** Full secret — return once to the operator; never store. */
  fullKey: string;
  /** Non-secret lookup prefix (first API_KEY_LOOKUP_PREFIX_CHARS chars). */
  prefix: string;
  /** SHA-256 hex of the full key. */
  keyHash: string;
}>;

export type IssueApiKeyResult =
  | { ok: true; issued: IssuedApiKey }
  | { ok: false; reason: "prefix_exhausted" | "unexpected_duplicate" };

function buildCandidate(literal: string): IssuedApiKey {
  // literal (8) + 8 hex = 16-char prefix; rest is secret entropy.
  const randomHex = randomToken(API_KEY_SECRET_BYTES);
  const fullKey = `${literal}${randomHex}`;
  const prefix = fullKey.slice(0, API_KEY_LOOKUP_PREFIX_CHARS);
  const keyHash = hashToken(fullKey);
  return { fullKey, prefix, keyHash };
}

/**
 * Issue a key with bounded retry on confirmed unique-index collisions.
 * `insert` must throw on duplicate prefix (or return a signal); only
 * Mongo E11000 / duplicate-key errors are retried.
 */
export async function issueApiKeyWithRetry(params: {
  literal: string;
  insert: (issued: IssuedApiKey) => Promise<void>;
  maxAttempts?: number;
}): Promise<IssueApiKeyResult> {
  const max = params.maxAttempts ?? API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT;
  let lastWasDuplicate = false;
  for (let attempt = 0; attempt < max; attempt++) {
    const issued = buildCandidate(params.literal);
    try {
      await params.insert(issued);
      return { ok: true, issued };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        lastWasDuplicate = true;
        continue;
      }
      throw err;
    }
  }
  return {
    ok: false,
    reason: lastWasDuplicate ? "prefix_exhausted" : "unexpected_duplicate",
  };
}

export function issueCustomerApiKeyMaterial(): IssuedApiKey {
  return buildCandidate(CUSTOMER_KEY_PREFIX_LITERAL);
}

export function issueManagementApiKeyMaterial(): IssuedApiKey {
  return buildCandidate(MANAGEMENT_KEY_PREFIX_LITERAL);
}
