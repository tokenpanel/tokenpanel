/**
 * Terminal SSE error helpers shared by the streaming routes
 * (/v1/chat/completions, /v1/messages, /admin/playground/chat).
 */

import {
  publicError,
  toPublicError,
  type PublicError,
  type PublicErrorCode,
} from "../errors/catalog.ts";
import { classifyGenerationFailure } from "../domains/providers/generation.ts";

/** Stream-only failure codes → catalogue codes. */
export function standardStreamCode(code: string): PublicErrorCode {
  switch (code) {
    case "stream_truncated":
      return "stream_interrupted";
    case "accepted_upstream_failed":
      return "provider_unavailable";
    default:
      // malformed_sse, upstream_error, anything adapter-specific.
      return "provider_protocol";
  }
}

/** Standard terminal error for a stream-only code. */
export function standardStreamError(code: string): PublicError {
  return publicError(standardStreamCode(code));
}

/** Standard terminal error for a thrown/failed generation. */
export function standardGenerationError(
  err: unknown,
  opts?: { readonly streamCommitted?: boolean; readonly debug?: boolean },
): PublicError {
  const classified = classifyGenerationFailure(err, {
    streamCommitted: opts?.streamCommitted === true,
  });
  return toPublicError(classified, { debug: opts?.debug === true });
}
