/**
 * Stable safe public messages (task 4.9).
 * Never echo raw driver/JWT/crypto/provider body text to clients.
 */

export const SAFE_MESSAGES = {
  unauthorized: "Unauthorized",
  invalid_credentials: "Invalid credentials",
  forbidden: "Forbidden",
  missing_scope: "Missing required scope",
  user_disabled: "User disabled",
  not_found: "Not found",
  validation_error: "Validation failed",
  conflict: "Conflict",
  invalid_state: "Invalid state",
  insufficient_balance: "Insufficient balance to complete request",
  currency_mismatch: "Customer balance currency does not match model currency",
  budget_exceeded: "Budget exceeded",
  rate_limited: "Rate limit exceeded",
  provider_rejected: "Provider rejected the request",
  provider_unavailable: "Provider unavailable",
  provider_timeout: "Provider request timed out",
  provider_protocol: "Provider response protocol error",
  all_providers_failed: "All providers failed",
  no_active_entries: "Model has no active provider entries",
  adapter_missing: "Provider adapter missing",
  upstream_error: "Upstream provider error",
  persistence_duplicate_key: "Duplicate key conflict",
  persistence_conflict: "Database conflict",
  persistence_unavailable: "Database unavailable",
  persistence_timeout: "Database operation timed out",
  persistence_data: "Invalid stored data",
  configuration_error: "Server misconfigured",
  server_misconfigured: "Server misconfigured",
  internal_server_error: "Internal server error",
  system_error: "Internal server error",
  dependency_unavailable: "Dependency unavailable",
} as const;

export type SafeMessageKey = keyof typeof SAFE_MESSAGES;

/** JWT private causes (logs) → public-safe reason (enumeration-safe). */
export const JWT_PUBLIC_REASON = "unauthorized" as const;

const JWT_PRIVATE_REASONS = new Set([
  "malformed jwt",
  "bad signature",
  "unsupported alg",
  "malformed payload",
  "expired",
  "bad subject",
]);

/**
 * Map a JwtError (or similar) message to a private reason + public-safe reason.
 * Public always stays generic for enumeration safety; private retains precision.
 */
export function classifyJwtMessage(raw: string): {
  privateReason: string;
  publicReason: undefined;
  code: "unauthorized";
  message: string;
} {
  const privateReason = JWT_PRIVATE_REASONS.has(raw) ? raw : "jwt_error";
  return {
    privateReason,
    publicReason: undefined,
    code: "unauthorized",
    message: SAFE_MESSAGES.unauthorized,
  };
}

/**
 * Whether a string looks like a raw infrastructure leak (for defensive sanitization).
 */
export function looksLikeUnsafeDiagnostic(text: string): boolean {
  return (
    /ECONNREFUSED|ENOTFOUND|ECONNRESET|MongoServer|mongodb(\+srv)?:\/\//i.test(text) ||
    /at\s+\S+\s+\(/i.test(text) || // stack-ish
    /api[_-]?key|password|secret|authorization|bearer\s+\S+/i.test(text) ||
    /sk-[a-zA-Z0-9]{10,}/i.test(text)
  );
}

/**
 * Prefer stable safe message; only keep domain messages that are already product-owned.
 */
export function publicMessageForCode(
  code: string,
  candidate?: string,
): string {
  const key = code as SafeMessageKey;
  if (key in SAFE_MESSAGES) {
    // Prefer product messages that don't leak infra; allow known BillingError messages.
    if (
      candidate &&
      !looksLikeUnsafeDiagnostic(candidate) &&
      candidate.length <= 300
    ) {
      return candidate;
    }
    return SAFE_MESSAGES[key];
  }
  if (candidate && !looksLikeUnsafeDiagnostic(candidate) && candidate.length <= 300) {
    return candidate;
  }
  return SAFE_MESSAGES.internal_server_error;
}
