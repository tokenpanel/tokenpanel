/**
 * Resolve effective provider HTTP timeout (ms).
 *
 * Precedence:
 * 1. Per-provider `httpTimeoutMs` when set (including 0 = disable)
 * 2. Process global `PROVIDER_HTTP_TIMEOUT_MS` (default 120_000)
 *
 * Callers treat 0 as "no app-level timeout" (only AbortSignal / client disconnect).
 */

export function resolveProviderHttpTimeoutMs(
  providerOverride: number | null | undefined,
  globalDefaultMs: number,
): number {
  if (providerOverride === undefined || providerOverride === null) {
    return globalDefaultMs;
  }
  return providerOverride;
}
