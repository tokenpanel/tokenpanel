import { hashToken, randomToken, isDuplicateKeyError } from "../lib/crypto.ts";

/**
 * Single owner for customer and management API-key material construction.
 * Routes retain authorization, scopes, labels, collection writes, and response
 * envelopes. Format and hashing stay compatible with existing stored keys.
 */

/** Customer public API keys (`tp_live_…`). */
export const CUSTOMER_KEY_PREFIX_LITERAL = "tp_live_";
/** Management API keys (`tp_mgmt_…`). */
export const MANAGEMENT_KEY_PREFIX_LITERAL = "tp_mgmt_";

/**
 * Lookup/display prefix length shared with public-auth dispatcher.
 * 8 literal + 8 random hex ≈ 4.3B prefix combos.
 */
export const API_KEY_LOOKUP_PREFIX_CHARS = 16;

/** Random secret material after the literal prefix (hex chars). */
export const API_KEY_SECRET_HEX_CHARS = 48; // 24 bytes

/** Bounded retries when unique prefix index collides. */
export const API_KEY_PREFIX_COLLISION_ATTEMPTS = 5;

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
  const randomHex = randomToken(24); // 48 hex chars
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
  const max = params.maxAttempts ?? API_KEY_PREFIX_COLLISION_ATTEMPTS;
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
