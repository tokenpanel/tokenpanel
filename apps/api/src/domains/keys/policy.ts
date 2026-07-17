/**
 * API key domain policy — re-exports security-policy key format constants.
 *
 * Policy version: 2026-07-15
 * Authority: apps/api/src/config/security-policy.ts (crypto-compatible formats).
 * Domain modules import from here; security-policy remains the declaration site.
 */

export {
  SECURITY_POLICY_VERSION,
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
  API_KEY_LOOKUP_PREFIX_CHARS,
  API_KEY_SECRET_HEX_CHARS,
  API_KEY_SECRET_BYTES,
  API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT,
} from "../../config/security-policy.ts";

/** Historical alias (attempts count). Prefer *_COUNT suffix. */
export { API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT as API_KEY_PREFIX_COLLISION_ATTEMPTS } from "../../config/security-policy.ts";
