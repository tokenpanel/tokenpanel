/**
 * Pure API runtime configuration parser.
 * No side effects: does not read process.env itself; callers pass a source map.
 *
 * Critical: JWT_SECRET is returned as the exact input string (no trim/normalize/
 * hash). Provider credential encryption depends on those exact bytes.
 */

export type ApiEnvironment = "development" | "test" | "production";

/**
 * Operational intervals, timeouts, concurrency, and cache TTLs.
 * All timing fields use millisecond units (`*Ms`); counts use `*Count`.
 * Env vars are optional — defaults match historical hard-coded behavior.
 */
export type ApiOperationalConfig = Readonly<{
  /**
   * Settlement outbox reconcile poll interval.
   * Env: SETTLEMENT_RECONCILE_INTERVAL_MS. Default: 15000.
   * Matches historical startSettlementReconcileWorker default.
   */
  settlementReconcileIntervalMs: number;
  /**
   * Max outbox rows claimed per reconcile tick.
   * Env: SETTLEMENT_RECONCILE_BATCH_SIZE. Default: 20.
   */
  settlementReconcileBatchSizeCount: number;
  /**
   * Delay before first reconcile tick after worker start.
   * Env: SETTLEMENT_RECONCILE_INITIAL_DELAY_MS. Default: 3000.
   */
  settlementReconcileInitialDelayMs: number;
  /**
   * Application-level provider HTTP timeout (global default).
   * Env: PROVIDER_HTTP_TIMEOUT_MS. Default: 120_000 (2 minutes).
   * 0 = no app-level timeout (only request AbortSignal / client disconnect).
   * Non-zero: enforced on listModels/chatComplete (full request) and on
   * streamChat TTFB/headers only (stream body is not timed out).
   * Per-provider `httpTimeoutMs` overrides this when set.
   */
  providerHttpTimeoutMs: number;
  /**
   * In-memory catalog-source response cache TTL.
   * Env: CATALOG_CACHE_TTL_MS. Default: 600000 (10 minutes).
   * Matches catalog-sources/registry.ts historical TTL_MS.
   */
  catalogCacheTtlMs: number;
  /**
   * Max concurrent reconcile row handlers within a batch (reserved).
   * Env: WORKER_CONCURRENCY. Default: 1 (serial, current behavior).
   */
  workerConcurrencyCount: number;
  /**
   * Bounded graceful-shutdown budget (interrupt workers, dispose runtime, close Mongo).
   * Env: SHUTDOWN_TIMEOUT_MS. Default: 10000.
   */
  shutdownTimeoutMs: number;
}>;

/** Documented operational defaults (single source for parse + tests). */
export const DEFAULT_OPERATIONAL_CONFIG: ApiOperationalConfig = Object.freeze({
  settlementReconcileIntervalMs: 15_000,
  settlementReconcileBatchSizeCount: 20,
  settlementReconcileInitialDelayMs: 3_000,
  /** 2 min — protects hung upstreams; set 0 to disable; per-provider override available. */
  providerHttpTimeoutMs: 120_000,
  catalogCacheTtlMs: 10 * 60 * 1000,
  workerConcurrencyCount: 1,
  shutdownTimeoutMs: 10_000,
});

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
  /** Intervals, timeouts, concurrency, cache TTLs (see ApiOperationalConfig). */
  operational: ApiOperationalConfig;
  /**
   * When true, resolve client IP from reverse-proxy headers if the TCP peer
   * is in `trustedProxies` (see TRUST_PROXY). Default false — socket only.
   */
  trustProxy: boolean;
  /**
   * Exact IPs or CIDRs of reverse proxies allowed to set client-IP headers.
   * Empty + trustProxy → private/loopback defaults (Docker + Caddy).
   * Env: TRUSTED_PROXIES (comma-separated).
   */
  trustedProxies: readonly string[];
  /**
   * Prefer CF-Connecting-IP when the TCP peer is a Cloudflare edge IP.
   * Not used for private reverse proxies (Caddy) — those must put the
   * client in X-Real-IP after sanitizing. Env: TRUST_CLOUDFLARE. Default false.
   */
  trustCloudflare: boolean;
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

/**
 * Parse a non-negative integer env var (milliseconds or counts).
 * Unset/empty → default. Invalid → issue + default (aggregation continues).
 */
function parseNonNegativeInt(
  raw: string | undefined,
  variable: string,
  defaultValue: number,
  issues: { variable: string; reason: string }[],
  opts?: { max?: number },
): number {
  if (raw === undefined || raw === "") return defaultValue;
  if (raw.trim() !== raw || raw.includes(" ")) {
    issues.push({
      variable,
      reason: "must be a non-negative decimal integer without whitespace",
    });
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    issues.push({
      variable,
      reason: "must be a non-negative decimal integer",
    });
    return defaultValue;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    issues.push({
      variable,
      reason: "must be a non-negative safe integer",
    });
    return defaultValue;
  }
  if (opts?.max !== undefined && n > opts.max) {
    issues.push({
      variable,
      reason: `must be <= ${opts.max}`,
    });
    return defaultValue;
  }
  return n;
}

function parseBoolEnv(
  raw: string | undefined,
  variable: string,
  defaultValue: boolean,
  issues: { variable: string; reason: string }[],
): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  issues.push({
    variable,
    reason: "must be a boolean (true/false, 1/0, yes/no, on/off)",
  });
  return defaultValue;
}

/**
 * Comma-separated IPs or CIDRs. Empty → []. Invalid entries are skipped with
 * an issue (aggregation continues).
 */
function parseTrustedProxies(
  raw: string | undefined,
  issues: { variable: string; reason: string }[],
): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part.includes("/")) {
      const slash = part.indexOf("/");
      const base = part.slice(0, slash);
      const bits = part.slice(slash + 1);
      if (!/^\d+$/.test(bits)) {
        issues.push({
          variable: "TRUSTED_PROXIES",
          reason: `invalid CIDR prefix length: ${part}`,
        });
        continue;
      }
      const n = Number(bits);
      const isV4 = /^\d+\.\d+\.\d+\.\d+$/.test(base);
      const maxBits = isV4 ? 32 : 128;
      if (n < 0 || n > maxBits) {
        issues.push({
          variable: "TRUSTED_PROXIES",
          reason: `CIDR prefix out of range: ${part}`,
        });
        continue;
      }
      // Base must look like an IP (full validation is in client-ip at match time).
      if (base.length === 0 || base.length > 45) {
        issues.push({
          variable: "TRUSTED_PROXIES",
          reason: `invalid proxy address: ${part}`,
        });
        continue;
      }
      out.push(part);
    } else {
      if (part.length === 0 || part.length > 45) {
        issues.push({
          variable: "TRUSTED_PROXIES",
          reason: `invalid proxy address: ${part}`,
        });
        continue;
      }
      out.push(part);
    }
  }
  return out;
}

function parseOperationalConfig(
  source: Readonly<Record<string, string | undefined>>,
  issues: { variable: string; reason: string }[],
): ApiOperationalConfig {
  const d = DEFAULT_OPERATIONAL_CONFIG;
  return Object.freeze({
    settlementReconcileIntervalMs: parseNonNegativeInt(
      source.SETTLEMENT_RECONCILE_INTERVAL_MS,
      "SETTLEMENT_RECONCILE_INTERVAL_MS",
      d.settlementReconcileIntervalMs,
      issues,
      { max: 24 * 60 * 60 * 1000 },
    ),
    settlementReconcileBatchSizeCount: parseNonNegativeInt(
      source.SETTLEMENT_RECONCILE_BATCH_SIZE,
      "SETTLEMENT_RECONCILE_BATCH_SIZE",
      d.settlementReconcileBatchSizeCount,
      issues,
      { max: 10_000 },
    ),
    settlementReconcileInitialDelayMs: parseNonNegativeInt(
      source.SETTLEMENT_RECONCILE_INITIAL_DELAY_MS,
      "SETTLEMENT_RECONCILE_INITIAL_DELAY_MS",
      d.settlementReconcileInitialDelayMs,
      issues,
      { max: 24 * 60 * 60 * 1000 },
    ),
    providerHttpTimeoutMs: parseNonNegativeInt(
      source.PROVIDER_HTTP_TIMEOUT_MS,
      "PROVIDER_HTTP_TIMEOUT_MS",
      d.providerHttpTimeoutMs,
      issues,
      { max: 60 * 60 * 1000 },
    ),
    catalogCacheTtlMs: parseNonNegativeInt(
      source.CATALOG_CACHE_TTL_MS,
      "CATALOG_CACHE_TTL_MS",
      d.catalogCacheTtlMs,
      issues,
      { max: 24 * 60 * 60 * 1000 },
    ),
    workerConcurrencyCount: parseNonNegativeInt(
      source.WORKER_CONCURRENCY,
      "WORKER_CONCURRENCY",
      d.workerConcurrencyCount,
      issues,
      { max: 256 },
    ),
    shutdownTimeoutMs: parseNonNegativeInt(
      source.SHUTDOWN_TIMEOUT_MS,
      "SHUTDOWN_TIMEOUT_MS",
      d.shutdownTimeoutMs,
      issues,
      { max: 10 * 60 * 1000 },
    ),
  });
}

/**
 * Parse and validate API runtime config from an env-like map.
 * Aggregates all issues before throwing ConfigValidationError.
 *
 * This is the single source of truth for validation semantics (JWT exact
 * bytes, production secret policy, Mongo URI, CORS, operational defaults).
 * Effect decode path wraps this function.
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
  const operational = parseOperationalConfig(source, issues);
  const trustProxy = parseBoolEnv(
    source.TRUST_PROXY,
    "TRUST_PROXY",
    false,
    issues,
  );
  const trustedProxies = parseTrustedProxies(source.TRUSTED_PROXIES, issues);
  const trustCloudflare = parseBoolEnv(
    source.TRUST_CLOUDFLARE,
    "TRUST_CLOUDFLARE",
    false,
    issues,
  );

  if (environment === "production" && corsOrigins === null) {
    // Production without explicit CORS: no broad reflection (same-origin only).
    // Represent as empty allowlist so the CORS handler does not reflect arbitrary origins.
  }

  // Batch size 0 is invalid for worker progress (would spin forever no-op).
  if (operational.settlementReconcileBatchSizeCount < 1) {
    issues.push({
      variable: "SETTLEMENT_RECONCILE_BATCH_SIZE",
      reason: "must be >= 1",
    });
  }
  if (operational.workerConcurrencyCount < 1) {
    issues.push({
      variable: "WORKER_CONCURRENCY",
      reason: "must be >= 1",
    });
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
    operational,
    trustProxy,
    trustedProxies: Object.freeze([...trustedProxies]),
    trustCloudflare,
  });
}
