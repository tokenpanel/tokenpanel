/**
 * Browser-safe public configuration for the admin SPA.
 * Only VITE_* values that are intentionally embedded at build time.
 * Never put secrets here — they ship in the browser bundle.
 */

export type AdminPublicConfig = Readonly<{
  /**
   * API base URL. Empty string = same-origin (Vite proxy in dev; API-served
   * SPA in production).
   */
  apiBaseUrl: string;
}>;

function normalizeBaseUrl(raw: string): string {
  if (raw === "") return "";
  // Strip trailing slashes once so callers can join with `/path`.
  return raw.replace(/\/+$/, "");
}

function isAllowedHttpBase(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse public config from Vite import.meta.env-like source.
 * Empty / unset VITE_API_BASE_URL → same-origin.
 */
export function parseAdminPublicConfig(
  source: Readonly<Record<string, string | undefined>>,
): AdminPublicConfig {
  const raw = source.VITE_API_BASE_URL ?? "";
  if (raw === "") {
    return Object.freeze({ apiBaseUrl: "" });
  }
  const normalized = normalizeBaseUrl(raw.trim());
  if (!isAllowedHttpBase(normalized)) {
    throw new Error(
      `Invalid VITE_API_BASE_URL: must be empty (same-origin) or an http(s) URL`,
    );
  }
  return Object.freeze({ apiBaseUrl: normalized });
}

/** Resolved once from import.meta.env at module load in the browser. */
export const adminPublicConfig: AdminPublicConfig = parseAdminPublicConfig({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL as string | undefined,
});
