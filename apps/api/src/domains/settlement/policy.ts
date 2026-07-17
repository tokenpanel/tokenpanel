/**
 * Settlement outbox / recon policy (server-only).
 *
 * Policy version: 2026-07-15
 * Owner: domains/settlement. Lease, backoff, attempt caps, and gateway id
 * bounds. Operational poll interval/batch live in runtime config
 * (ApiOperationalConfig); these are product/safety invariants.
 */

export const SETTLEMENT_POLICY_VERSION = "2026-07-15" as const;

/** Max recon attempts before marking abandoned. Unit: count. */
export const OUTBOX_MAX_ATTEMPTS_COUNT = 20;

/** Claim lease: stuck in_progress rows reclaimable after this. Unit: ms. */
export const OUTBOX_CLAIM_LEASE_MS = 5 * 60 * 1000;

/** Max stored length for gatewayRequestId (schema + unique index). Unit: count (chars). */
export const GATEWAY_REQUEST_ID_MAX_CHARS = 80;

/** Base backoff for nextAttemptAt. Unit: seconds. Doubles each attempt. */
export const OUTBOX_BACKOFF_BASE_SECONDS = 5;

/** Cap on exponential backoff. Unit: seconds. */
export const OUTBOX_BACKOFF_CAP_SECONDS = 3600;

/** Max stored reason string on outbox row. Unit: count (chars). */
export const SETTLEMENT_REASON_MAX_CHARS = 200;

/** Hex claim-token entropy. Unit: bytes. */
export const OUTBOX_CLAIM_TOKEN_BYTES = 16;

// Historical names (unit suffix preferred for new code).
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_MAX_ATTEMPTS_COUNT;
export const GATEWAY_REQUEST_ID_MAX = GATEWAY_REQUEST_ID_MAX_CHARS;
