/**
 * Typed provider failure classification for safe fallback decisions.
 * Fallback is allowed only for explicit pre-commit eligible failures.
 */

export type ProviderErrorCategory =
  | "connection"
  | "timeout_pre_send"
  | "timeout_ambiguous"
  | "http_4xx"
  | "http_5xx"
  | "capacity"
  | "validation"
  | "auth"
  | "malformed_response"
  | "missing_usage"
  | "abort"
  | "unknown";

export type ProviderErrorPhase =
  | "connect"
  | "request"
  | "headers"
  | "body"
  | "stream"
  | "parse";

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly phase: ProviderErrorPhase;
  readonly httpStatus?: number;
  readonly providerRequestId?: string;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;
  /** True if the request may have been accepted upstream. */
  readonly maybeAcceptedUpstream: boolean;
  /** True once any client-visible stream byte/delta was emitted. */
  readonly streamCommitted: boolean;
  readonly diagnostic?: string;

  constructor(params: {
    message: string;
    category: ProviderErrorCategory;
    phase: ProviderErrorPhase;
    httpStatus?: number;
    providerRequestId?: string;
    retryable?: boolean;
    fallbackEligible?: boolean;
    maybeAcceptedUpstream?: boolean;
    streamCommitted?: boolean;
    diagnostic?: string;
  }) {
    super(params.message);
    this.name = "ProviderError";
    this.category = params.category;
    this.phase = params.phase;
    this.httpStatus = params.httpStatus;
    this.providerRequestId = params.providerRequestId;
    this.retryable = params.retryable ?? false;
    this.fallbackEligible = params.fallbackEligible ?? false;
    this.maybeAcceptedUpstream = params.maybeAcceptedUpstream ?? false;
    this.streamCommitted = params.streamCommitted ?? false;
    this.diagnostic = params.diagnostic?.slice(0, 500);
  }
}

/** Classify an HTTP status for fallback policy. */
export function classifyHttpStatus(status: number): {
  category: ProviderErrorCategory;
  fallbackEligible: boolean;
  retryable: boolean;
} {
  if (status === 408 || status === 429) {
    return { category: "capacity", fallbackEligible: true, retryable: true };
  }
  if (status >= 500) {
    return { category: "http_5xx", fallbackEligible: true, retryable: true };
  }
  if (status === 401 || status === 403) {
    return { category: "auth", fallbackEligible: false, retryable: false };
  }
  if (status >= 400) {
    return { category: "http_4xx", fallbackEligible: false, retryable: false };
  }
  return { category: "unknown", fallbackEligible: false, retryable: false };
}

/**
 * Whether fallback to the next configured entry is allowed.
 * Terminal after stream commit. Eligible categories include 408/429/5xx and
 * pre-send connection failures. maybeAcceptedUpstream is retained for metrics
 * but does not block configured capacity/5xx failover (product choice).
 */
export function isFallbackAllowed(err: unknown, streamCommitted: boolean): boolean {
  if (streamCommitted) return false;
  if (err instanceof ProviderError) {
    if (err.streamCommitted) return false;
    // Explicit body/stream failures after accept: never failover (duplicate work).
    // Exception: capacity/5xx on headers phase remain eligible via fallbackEligible.
    if (
      (err.phase === "body" || err.phase === "stream") &&
      err.fallbackEligible === false
    ) {
      return false;
    }
    if (err.maybeAcceptedUpstream && err.fallbackEligible === false) return false;
    return err.fallbackEligible;
  }
  // TypeError/connect only eligible pre-headers. After body starts, adapters
  // throw ProviderError(phase=body, fallbackEligible:false).
  if (err instanceof TypeError) return true;
  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Public-safe provider failure message (no upstream body). Bodies may contain
 * secrets, prompts, or internal paths and must stay in `diagnostic` only.
 */
export function publicProviderErrorMessage(
  label: string,
  status?: number,
): string {
  if (status !== undefined) {
    return `${label} failed (HTTP ${status})`;
  }
  return `${label} failed`;
}

/** Build a ProviderError from an upstream HTTP status + bounded body. */
export function providerHttpError(
  status: number,
  body: string,
  phase: ProviderErrorPhase,
  label = "upstream",
): ProviderError {
  const c = classifyHttpStatus(status);
  return new ProviderError({
    // Never put upstream body in `message` — it flows to public API clients via
    // BillingError / route error envelopes.
    message: publicProviderErrorMessage(label, status),
    category: c.category,
    phase,
    httpStatus: status,
    fallbackEligible: c.fallbackEligible,
    retryable: c.retryable,
    // 5xx/408 after send may have been accepted; still fallback-eligible per policy.
    maybeAcceptedUpstream: status >= 500 || status === 408,
    diagnostic: body.slice(0, 500),
  });
}
