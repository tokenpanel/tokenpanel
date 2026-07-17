/**
 * Baseline security headers for direct API/SPA deployment (no Caddy edge).
 * Caddy template sets overlapping headers; duplicates are harmless.
 *
 * CSP is intentionally tight for same-origin SPA + JSON API. When the admin
 * SPA is split-origin (VITE_API_BASE_URL), browsers still enforce CSP on the
 * document origin — API JSON responses' CSP is largely irrelevant.
 */
import type { MiddlewareHandler } from "hono";

/** CSP for HTML documents and default for other responses. */
export const DEFAULT_CONTENT_SECURITY_POLICY = [
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
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join("; ");

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
    c.header("Content-Security-Policy", DEFAULT_CONTENT_SECURITY_POLICY);
  }
};
