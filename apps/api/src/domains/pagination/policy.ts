/**
 * List pagination policy (server-only).
 *
 * Policy version: 2026-07-15
 * Shared by admin and management list endpoints. Single-use dashboard
 * `.limit(5)` stays local (not promoted).
 */

export const PAGINATION_POLICY_VERSION = "2026-07-15" as const;

/** Default page size when client omits limit. Unit: count (rows). */
export const PAGINATION_DEFAULT_LIMIT_COUNT = 50;

/** Max page size accepted on list queries. Unit: count (rows). */
export const PAGINATION_MAX_LIMIT_COUNT = 500;
