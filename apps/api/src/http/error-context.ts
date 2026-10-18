/**
 * Per-request error style: which envelope and which standard apply.
 *
 * - `/admin/*` (bundled admin UI) always uses the standard, with upstream
 *   provider detail for debugging.
 * - `/v1/*` (OpenAI/Anthropic-compatible) always uses the standard in the
 *   provider's own error format. No TokenPanel header: SDKs and tools built
 *   for those APIs must work unchanged.
 * - `/api/management/*` keeps its legacy (version 1) responses unless the
 *   client sends `TokenPanel-Version: 2`; live integrations depend on them.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { HttpSurface } from "../errors/variants.ts";
import type { RenderedHttpError } from "./renderers/types.ts";
import { renderStandardCode } from "./renderers/standard.ts";
import type { PublicErrorCode } from "../errors/catalog.ts";

export const API_VERSION_HEADER = "TokenPanel-Version";
export const SUPPORTED_API_VERSIONS = [1, 2] as const;
export type ApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];

export type ErrorStyle = {
  /** Envelope family the client expects for this path. */
  readonly surface: HttpSurface;
  /** Catalogue-based standard (version 2 or admin) vs legacy version 1. */
  readonly standard: boolean;
  /** Include admin-only upstream provider detail. */
  readonly debug: boolean;
  /** Negotiated version; null where versioning does not apply (admin, /v1). */
  readonly version: ApiVersion | null;
};

function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

/** Envelope surface for a public path, or null for paths without one. */
export function versionedSurfaceForPath(path: string): HttpSurface | null {
  if (path === "/v1/messages" || path.startsWith("/v1/messages/")) {
    return "anthropic";
  }
  if (path === "/v1" || path.startsWith("/v1/")) return "openai";
  if (path === "/api/management" || path.startsWith("/api/management/")) {
    return "management";
  }
  return null;
}

/** Parsed header: a supported version, absent (null), or invalid. */
export function parseApiVersion(
  raw: string | undefined,
): ApiVersion | null | "invalid" {
  if (raw === undefined) return null;
  const v = raw.trim();
  if (v === "1") return 1;
  if (v === "2") return 2;
  return "invalid";
}

export function resolveErrorStyle(
  path: string,
  headerValue: string | undefined,
): ErrorStyle {
  if (isAdminPath(path)) {
    return { surface: "admin", standard: true, debug: true, version: null };
  }
  const surface = versionedSurfaceForPath(path);
  if (surface === "openai" || surface === "anthropic") {
    return { surface, standard: true, debug: false, version: null };
  }
  const parsed = parseApiVersion(headerValue);
  // Invalid values are rejected by apiVersionMiddleware in the standard.
  const version: ApiVersion = parsed === "invalid" ? 2 : (parsed ?? 1);
  return {
    // Unversioned paths (unknown routes) keep the legacy native envelope.
    surface: versionedSurfaceForPath(path) ?? "management",
    standard: version === 2,
    debug: false,
    version,
  };
}

export function errorStyleOf(c: Context): ErrorStyle {
  // Tolerates partial request doubles (unit tests) and plain Requests.
  const req = c.req as Partial<Context["req"]>;
  const raw = req.raw as Partial<Request> | undefined;
  let path = typeof req.path === "string" ? req.path : "";
  if (!path && typeof raw?.url === "string") {
    try {
      path = new URL(raw.url).pathname;
    } catch {
      path = "";
    }
  }
  const header =
    typeof req.header === "function"
      ? req.header(API_VERSION_HEADER)
      : (raw?.headers?.get(API_VERSION_HEADER) ?? undefined);
  return resolveErrorStyle(path, header);
}

/**
 * Validates `TokenPanel-Version` and echoes the negotiated version on the
 * Management API. Other paths ignore the header.
 */
export const apiVersionMiddleware: MiddlewareHandler = async (c, next) => {
  if (versionedSurfaceForPath(c.req.path) !== "management") return next();
  const parsed = parseApiVersion(c.req.header(API_VERSION_HEADER));
  if (parsed === "invalid") {
    const r = renderStandardCode("management", "unsupported_api_version", {
      details: { supportedVersions: [...SUPPORTED_API_VERSIONS] },
    });
    return c.json(r.body, r.status as 400, r.headers);
  }
  await next();
  c.header(API_VERSION_HEADER, String(parsed ?? 1));
};

/** JSON Response for a rendered error (keeps Hono context headers). */
export function renderedJson(c: Context, r: RenderedHttpError): Response {
  return c.json(r.body as object, r.status as 400, r.headers);
}

/**
 * Route/middleware-level error: the exact legacy response for version 1,
 * the catalogue error under the standard.
 */
export function respondWithCode(
  c: Context,
  code: PublicErrorCode,
  legacy: () => Response,
  extra?: Parameters<typeof renderStandardCode>[2],
): Response {
  const style = errorStyleOf(c);
  if (!style.standard) return legacy();
  return renderedJson(c, renderStandardCode(style.surface, code, extra));
}

/** 404 for an unknown or malformed resource id (legacy: `{error:"not_found"}`). */
export function notFoundResponse(c: Context): Response {
  return respondWithCode(c, "not_found", () => c.json({ error: "not_found" }, 404));
}
