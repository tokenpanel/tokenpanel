/**
 * Versioned security / identity policy (server-only).
 *
 * Policy version: 2026-07-15
 *
 * Owner: apps/api config (security). Not deployment-tunable via env —
 * changing values alters crypto compatibility, auth wire formats, or
 * brute-force resistance. JWT secret bytes remain in runtime config.
 *
 * Do NOT change ENCRYPT_* or key-format constants without a coordinated
 * data migration; existing ciphertext and stored key hashes depend on them.
 */

export const SECURITY_POLICY_VERSION = "2026-07-15" as const;

// ---------------------------------------------------------------------------
// JWT (HS256)
// ---------------------------------------------------------------------------

/** Default access-token lifetime. Unit: seconds. */
export const JWT_DEFAULT_TTL_SECONDS = 86_400;

/** Only supported JWT alg (reject others on verify). */
export const JWT_ALG = "HS256" as const;

/** JWT typ header value. */
export const JWT_TYP = "JWT" as const;

// ---------------------------------------------------------------------------
// Symmetric encryption at rest (provider API keys) — AES-256-GCM
// Format: base64(iv | ciphertext | tag). Key = SHA-256(JWT_SECRET)[0..32).
// ---------------------------------------------------------------------------

/** AES-GCM IV length. Unit: bytes. Changing breaks decrypt of existing blobs. */
export const ENCRYPT_IV_BYTES = 12;

/** AES-GCM auth tag length. Unit: bytes. Changing breaks decrypt. */
export const ENCRYPT_AUTH_TAG_BYTES = 16;

/** Derived key length from SHA-256(JWT_SECRET). Unit: bytes. */
export const ENCRYPT_KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Password / username (argon2id via Bun.password)
// ---------------------------------------------------------------------------

/** Minimum password length on signup / change / invite accept. Unit: count (chars). */
export const PASSWORD_MIN_LEN_COUNT = 8;

/** Maximum password length accepted on wire. Unit: count (chars). */
export const PASSWORD_MAX_LEN_COUNT = 256;

/** Minimum username length (invite accept / signup). Unit: count (chars). */
export const USERNAME_MIN_LEN_COUNT = 3;

/** Maximum username length. Unit: count (chars). */
export const USERNAME_MAX_LEN_COUNT = 60;

/** Username character class (invite accept). */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** Default invite TTL when client omits ttlHours. Unit: hours. */
export const INVITE_DEFAULT_TTL_HOURS = 168;

/** Max invite TTL accepted on create. Unit: hours. */
export const INVITE_MAX_TTL_HOURS = 720;

/** Random token entropy for invite tokens. Unit: bytes (hex-encoded 2×). */
export const INVITE_TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// API key material (customer tp_live_ / management tp_mgmt_)
// ---------------------------------------------------------------------------

/** Customer public API keys. Changing invalidates prefix classification. */
export const CUSTOMER_KEY_PREFIX_LITERAL = "tp_live_";

/** Management API keys. Changing invalidates prefix classification. */
export const MANAGEMENT_KEY_PREFIX_LITERAL = "tp_mgmt_";

/**
 * Lookup/display prefix length (literal + random hex).
 * Unit: count (chars). Shared with public-auth dispatcher.
 */
export const API_KEY_LOOKUP_PREFIX_CHARS = 16;

/** Random secret material after the literal prefix. Unit: count (hex chars). */
export const API_KEY_SECRET_HEX_CHARS = 48; // 24 bytes

/** Random bytes for secret material (API_KEY_SECRET_HEX_CHARS / 2). Unit: bytes. */
export const API_KEY_SECRET_BYTES = 24;

/** Bounded retries when unique prefix index collides. Unit: count. */
export const API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT = 5;

// ---------------------------------------------------------------------------
// Credential failure throttles (in-memory, per process, keyed by client IP)
// Separate FailureThrottle instances per surface so login / API-key / invite
// keep independent attempt budgets (see apps/api/src/lib/throttle.ts).
// ---------------------------------------------------------------------------

/** Sliding window for counting failures. Unit: milliseconds. */
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/** Lockout duration after max attempts. Unit: milliseconds. */
export const THROTTLE_LOCKOUT_MS = 15 * 60 * 1000;

/** Max client IPs retained in one throttle map before global purge. Unit: count. */
export const THROTTLE_MAX_STORE_SIZE_COUNT = 50_000;

/** Admin login: failures from one IP before lockout. Unit: count. */
export const THROTTLE_LOGIN_MAX_ATTEMPTS_COUNT = 5;

/** Invite-token accept: failures from one IP before lockout. Unit: count. */
export const THROTTLE_INVITE_MAX_ATTEMPTS_COUNT = 5;

/** Public API-key auth: failures from one IP before lockout. Unit: count. */
export const THROTTLE_API_KEY_MAX_ATTEMPTS_COUNT = 10;
