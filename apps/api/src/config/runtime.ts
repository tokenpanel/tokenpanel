/**
 * Pure API runtime configuration parser.
 * No side effects: does not read process.env itself; callers pass a source map.
 *
 * Critical: JWT_SECRET is returned as the exact input string (no trim/normalize/
 * hash). Provider credential encryption depends on those exact bytes.
 */

export type ApiEnvironment = "development" | "test" | "production";

export type ApiRuntimeConfig = Readonly<{
  environment: ApiEnvironment;
  port: number;
  /** Exact JWT_SECRET bytes as provided — never log or include in errors. */
  jwtSecret: string;
  /**
   * When null, reflect request Origin (dev default).
   * When empty array in production, no cross-origin clients are allowed.
   * When non-empty, only listed exact origins are allowed.
   */
  corsOrigins: readonly string[] | null;
  database: Readonly<{
    uri: string;
    name: string;
  }>;
  /**
   * Org IDs (hex) where atomic balance reservation is enforcement (canary).
   * Empty → shadow-compare only; legacy checkBalance remains the reader.
   * See RESERVATION_CANARY_ORG_IDS and ADR 001.
   */
  reservationCanaryOrgIds: ReadonlySet<string>;
}>;

export class ConfigValidationError extends Error {
  readonly issues: readonly { variable: string; reason: string }[];

  constructor(issues: readonly { variable: string; reason: string }[]) {
    const summary = issues.map((i) => `${i.variable}: ${i.reason}`).join("; ");
    super(`Invalid API configuration: ${summary}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Known insecure sample secrets rejected in production.
 * Exact match after lowercasing (not substring of a real random secret).
 */
const PRODUCTION_REJECTED_SECRETS = new Set([
  "change_me_to_a_long_random_string",
  "change_me_to_a_long_random_string_32chars",
  "changeme",
  "secret",
  "jwt_secret",
  "test",
  "password",
  "passwordpasswordpasswordpassword", // 32-char weak filler
]);

/** Prefixes that mark documented sample secrets (env.example lineage). */
const PRODUCTION_REJECTED_SECRET_PREFIXES = [
  "change_me",
  "changeme",
  "replace_me",
  "your_jwt",
  "todo_secret",
] as const;

const MIN_JWT_SECRET_LEN = 32;

function isNonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/** True if secret is only whitespace or has no non-whitespace entropy. */
function isWeakWhitespaceSecret(raw: string): boolean {
  if (raw.trim().length === 0) return true;
  // All identical code points (e.g. 32 spaces, 32 zeros, repeated emoji).
  // Use spread so surrogate pairs / Unicode scalars are one unit; `/^(.)\1+$/`
  // only matches UTF-16 code units and misses repeated multi-unit characters.
  const points = [...raw];
  if (points.length >= 1 && points.every((c) => c === points[0])) return true;
  return false;
}

function isRejectedProductionSecret(raw: string): boolean {
  const lower = raw.toLowerCase();
  if (PRODUCTION_REJECTED_SECRETS.has(lower)) return true;
  if (isWeakWhitespaceSecret(raw)) return true;
  for (const prefix of PRODUCTION_REJECTED_SECRET_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

function parseEnvironment(
  raw: string | undefined,
  issues: { variable: string; reason: string }[],
): ApiEnvironment {
  const v = raw ?? "development";
  if (v === "development" || v === "test" || v === "production") return v;
  issues.push({
    variable: "NODE_ENV",
    reason: "must be development, test, or production",
  });
  return "development";
}

function parsePort(
  raw: string | undefined,
  issues: { variable: string; reason: string }[],
): number {
  const source = raw ?? "3000";
  if (source.trim() !== source || source.includes(" ")) {
    issues.push({ variable: "PORT", reason: "must be a decimal integer without whitespace" });
    return 3000;
  }
  if (!/^\d+$/.test(source)) {
    issues.push({ variable: "PORT", reason: "must be a decimal integer 1..65535" });
    return 3000;
  }
  const n = Number(source);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    issues.push({ variable: "PORT", reason: "must be a decimal integer 1..65535" });
    return 3000;
  }
  return n;
}

function parseJwtSecret(
  raw: string | undefined,
  environment: ApiEnvironment,
  issues: { variable: string; reason: string }[],
): string {
  if (!isNonBlank(raw)) {
    issues.push({
      variable: "JWT_SECRET",
      reason: "required (use a random 32+ character string)",
    });
    return "";
  }
  // Preserve exact bytes — do not trim (except we never rewrite the string).
  // Existing deployments may use short secrets that still decrypt provider
  // credentials; enforce length + sample rejection only in production.
  if (environment === "production") {
    if (raw.length < MIN_JWT_SECRET_LEN) {
      issues.push({
        variable: "JWT_SECRET",
        reason: `must be at least ${MIN_JWT_SECRET_LEN} characters in production`,
      });
    }
    if (isRejectedProductionSecret(raw)) {
      issues.push({
        variable: "JWT_SECRET",
        reason:
          "rejects known sample/default/weak values in production (generate a random 32+ char secret)",
      });
    }
  }
  return raw;
}

function parseMongoUri(
  raw: string | undefined,
  issues: { variable: string; reason: string }[],
): string {
  if (!isNonBlank(raw) || raw.trim().length === 0) {
    issues.push({
      variable: "MONGODB_URI",
      reason: "required (mongodb:// or mongodb+srv://)",
    });
    return "";
  }
  const uri = raw; // no trim of credentials-bearing URI
  if (!uri.startsWith("mongodb://") && !uri.startsWith("mongodb+srv://")) {
    issues.push({
      variable: "MONGODB_URI",
      reason: "must start with mongodb:// or mongodb+srv://",
    });
  }
  return uri;
}

function parseMongoDbName(
  raw: string | undefined,
  issues: { variable: string; reason: string }[],
): string {
  // Documented default: tokenpanel when unset (matches historical packages/db behavior).
  const name = raw === undefined || raw === "" ? "tokenpanel" : raw;
  if (name.length === 0 || name.length > 63) {
    issues.push({
      variable: "MONGODB_DB",
      reason: "must be 1..63 characters",
    });
    return name;
  }
  // MongoDB database name restrictions: no space, no /\. "$*<>:|?
  if (/[\/\\. "$*<>:|?]/.test(name) || name.includes("\0")) {
    issues.push({
      variable: "MONGODB_DB",
      reason: 'invalid characters (no /\\. "$*<>:|? or NUL)',
    });
  }
  return name;
}

/**
 * Parse CORS_ORIGINS.
 * - unset/empty → null (dev: reflect any origin)
 * - comma-separated list → validated exact origins
 * Production callers should treat empty allowlist as fail-closed for cross-origin.
 */
function parseCorsOrigins(
  raw: string | undefined,
  issues: { variable: string; reason: string }[],
): readonly string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      issues.push({
        variable: "CORS_ORIGINS",
        reason: `invalid origin URL: ${part}`,
      });
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push({
        variable: "CORS_ORIGINS",
        reason: `origin must be http or https: ${part}`,
      });
      continue;
    }
    if (url.username || url.password) {
      issues.push({
        variable: "CORS_ORIGINS",
        reason: `origin must not include credentials: ${part}`,
      });
      continue;
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      // URL always normalizes empty path to "/"; reject non-root paths/query/hash.
      if (url.pathname !== "/" || url.search || url.hash) {
        issues.push({
          variable: "CORS_ORIGINS",
          reason: `origin must not include path, query, or hash: ${part}`,
        });
        continue;
      }
    }
    if (url.search || url.hash) {
      issues.push({
        variable: "CORS_ORIGINS",
        reason: `origin must not include path, query, or hash: ${part}`,
      });
      continue;
    }
    // Reconstruct exact origin (scheme://host[:port])
    const origin = url.origin;
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

/** Parse RESERVATION_CANARY_ORG_IDS (comma-separated 24-hex ObjectIds). */
function parseReservationCanaryOrgIds(
  raw: string | undefined,
): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return new Set();
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (id.length === 0) continue;
    // Soft-validate: ignore invalid hex rather than fail boot (ops typo safe).
    if (!/^[0-9a-f]{24}$/.test(id)) continue;
    out.add(id);
  }
  return out;
}

/**
 * Parse and validate API runtime config from an env-like map.
 * Aggregates all issues before throwing ConfigValidationError.
 */
export function parseApiRuntimeConfig(
  source: Readonly<Record<string, string | undefined>>,
): ApiRuntimeConfig {
  const issues: { variable: string; reason: string }[] = [];

  const environment = parseEnvironment(source.NODE_ENV, issues);
  const port = parsePort(source.PORT, issues);
  const jwtSecret = parseJwtSecret(source.JWT_SECRET, environment, issues);
  const uri = parseMongoUri(source.MONGODB_URI, issues);
  const name = parseMongoDbName(source.MONGODB_DB, issues);
  const corsOrigins = parseCorsOrigins(source.CORS_ORIGINS, issues);
  const reservationCanaryOrgIds = parseReservationCanaryOrgIds(
    source.RESERVATION_CANARY_ORG_IDS,
  );

  if (environment === "production" && corsOrigins === null) {
    // Production without explicit CORS: no broad reflection (same-origin only).
    // Represent as empty allowlist so the CORS handler does not reflect arbitrary origins.
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  const resolvedCors: readonly string[] | null =
    environment === "production" && corsOrigins === null ? [] : corsOrigins;

  return Object.freeze({
    environment,
    port,
    jwtSecret,
    corsOrigins: resolvedCors === null ? null : Object.freeze([...resolvedCors]),
    database: Object.freeze({ uri, name }),
    reservationCanaryOrgIds,
  });
}
