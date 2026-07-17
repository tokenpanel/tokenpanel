/**
 * Baseline security headers for API/SPA responses.
 *
 * Non-CSP headers may also be set by the Caddy edge (duplicates with the same
 * values are harmless). CSP is owned only here — the Caddy template must not
 * set Content-Security-Policy, or it would override CSP_CONNECT_SRC and break
 * split-origin admin → API deploys.
 *
 * CSP is intentionally tight for same-origin SPA + JSON API. When the admin
 * SPA is split-origin (VITE_API_BASE_URL) and this server still serves the
 * HTML document, set CSP_CONNECT_SRC to the API origin(s) the SPA fetches.
 */
import type { MiddlewareHandler } from "hono";

/**
 * Build a Content-Security-Policy string.
 * @param connectSrcExtras Absolute origins (e.g. `https://api.example.com`)
 *   allowed beyond `'self'` for fetch/XHR/WebSocket. Used for split-origin
 *   admin → API when the SPA document is served under this CSP.
 */
export function buildContentSecurityPolicy(
  connectSrcExtras: readonly string[] = [],
): string {
  const connectParts = ["'self'", ...connectSrcExtras].filter(
    (part, index, arr) => part.length > 0 && arr.indexOf(part) === index,
  );
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    // Vite/React may inject style attributes; keep styles same-origin + inline.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectParts.join(" ")}`,
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** Parse CSP_CONNECT_SRC: comma- and/or whitespace-separated absolute origins. */
export function parseCspConnectSrcExtras(
  raw: string | undefined,
): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** CSP with no extras — same-origin only. */
export const DEFAULT_CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

function resolveContentSecurityPolicy(): string {
  const extras = parseCspConnectSrcExtras(process.env.CSP_CONNECT_SRC);
  if (extras.length === 0) return DEFAULT_CONTENT_SECURITY_POLICY;
  return buildContentSecurityPolicy(extras);
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  // Only set CSP when not already provided (edge may set a stricter one).
  if (!c.res.headers.has("Content-Security-Policy")) {
    c.header("Content-Security-Policy", resolveContentSecurityPolicy());
  }
};
