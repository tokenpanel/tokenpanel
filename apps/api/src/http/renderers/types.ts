/**
 * Shared HTTP renderer result types.
 */

import type { HttpSurface } from "../../errors/variants.ts";

export type { HttpSurface };

/** Fully-specified client response (status + JSON body + optional headers). */
export type RenderedHttpError = {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
};

export type BoundaryOutcome =
  | { readonly kind: "success"; readonly value: unknown }
  | { readonly kind: "error"; readonly response: RenderedHttpError }
  | { readonly kind: "interruption" }
  | {
      readonly kind: "defect";
      readonly response: RenderedHttpError;
      readonly privateLog: unknown;
    };

export function emptyHeaders(): Record<string, string> {
  return {};
}

export function withRetryAfter(
  headers: Record<string, string>,
  retryAfterSeconds: number | undefined,
): Record<string, string> {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return { ...headers, "Retry-After": String(retryAfterSeconds) };
  }
  return headers;
}
