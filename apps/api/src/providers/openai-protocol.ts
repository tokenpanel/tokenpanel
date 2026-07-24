/**
 * OpenAI-compatible protocol constants.
 *
 * Owner: providers/openai (protocol adapter). Do not merge with Anthropic
 * or billing constants that happen to share the same primitive value.
 */

/** SSE stream terminal marker payload (without `data: ` prefix). */
export const OPENAI_SSE_DONE_PAYLOAD = "[DONE]" as const;

/** Full SSE done line including framing. */
export const OPENAI_SSE_DONE_LINE = `data: ${OPENAI_SSE_DONE_PAYLOAD}\n\n` as const;

/** Generated chat completion id prefix. */
export const OPENAI_CHAT_COMPLETION_ID_PREFIX = "chatcmpl-" as const;

/** SSE Content-Type for streamed completions. */
export const OPENAI_SSE_CONTENT_TYPE = "text/event-stream" as const;

