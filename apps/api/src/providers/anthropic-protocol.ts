/**
 * Anthropic-compatible protocol constants.
 *
 * Owner: providers/anthropic (protocol adapter). Do not merge with billing
 * DEFAULT_COMPLETION_CAP_TOKENS even when values coincide (design §7).
 */

/** Required Anthropic API version header value. */
export const ANTHROPIC_API_VERSION = "2023-06-01" as const;

/** Generated message id prefix. */
export const ANTHROPIC_MESSAGE_ID_PREFIX = "msg_" as const;

/** SSE Content-Type for streamed messages. */
export const ANTHROPIC_SSE_CONTENT_TYPE = "text/event-stream" as const;

/**
 * Non-authoritative discovery fallback when upstream omits context.
 * Unit: tokens. Not used for billing.
 */
export const ANTHROPIC_DEFAULT_CONTEXT_TOKENS = 200_000;

/**
 * Protocol default max_tokens when request omits it (Messages API requires it).
 * Unit: tokens. Separate from billing DEFAULT_COMPLETION_CAP_TOKENS.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
