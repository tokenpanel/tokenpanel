import { CONFIG_FIELDS, MIN_JWT_SECRET_LEN } from "./fields.ts";
import { ConfigResolutionError, type ConfigField, type ConfigIssue, type ConfigValue } from "./types.ts";

export type ProxyMode = "caddy" | "direct";

export interface ResolveInput {
  readonly operator?: unknown;
  readonly legacyEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedConfig {
  readonly mode: ProxyMode;
  readonly values: Readonly<Record<string, ConfigValue>>;
  readonly env: Readonly<Record<string, string>>;
  readonly apiEnv: Readonly<Record<string, string>>;
  readonly composeVars: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getByPath(source: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = source;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function uriEncode(raw: string): string {
  return encodeURIComponent(raw).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      const s = asString(item);
      if (s !== undefined && s.length > 0) out.push(s);
    }
    return out;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "y"].includes(v)) return true;
    if (["0", "false", "no", "off", "n"].includes(v)) return false;
  }
  return undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function coerceValue(
  field: ConfigField,
  raw: unknown,
  issues: ConfigIssue[],
): ConfigValue | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const push = (reason: string) =>
    issues.push({ key: field.key, yamlPath: field.yamlPath, reason });

  switch (field.kind) {
    case "boolean": {
      const b = asBoolean(raw);
      if (b === undefined) push("must be a boolean");
      return b;
    }
    case "integer": {
      const n = asInteger(raw);
      if (n === undefined) {
        push("must be an integer");
        return undefined;
      }
      const { min, max } = field.validation ?? {};
      if (min !== undefined && n < min) push(`must be >= ${min}`);
      if (max !== undefined && n > max) push(`must be <= ${max}`);
      return n;
    }
    case "stringList":
    case "originList":
    case "proxyList": {
      const arr = asStringArray(raw);
      if (arr === undefined) push("must be a list");
      return arr;
    }
    default: {
      const s = asString(raw);
      if (s === undefined) push("must be a string");
      return s;
    }
  }
}

function validateStringConstraints(
  field: ConfigField,
  value: string,
  issues: ConfigIssue[],
): void {
  const { minLength, maxLength, pattern, choices } = field.validation ?? {};
  const push = (reason: string) =>
    issues.push({ key: field.key, yamlPath: field.yamlPath, reason });
  if (field.key !== "JWT_SECRET" && minLength !== undefined && value.length < minLength) {
    push(`must be at least ${minLength} characters`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    push(`must be at most ${maxLength} characters`);
  }
  if (pattern !== undefined && !new RegExp(pattern).test(value)) {
    push(`must match ${pattern}`);
  }
  if (choices !== undefined && !choices.includes(value)) {
    push(`must be one of: ${choices.join(", ")}`);
  }
}

function rawFor(
  field: ConfigField,
  operator: unknown,
  legacyEnv: Readonly<Record<string, string | undefined>>,
): unknown {
  if (field.yamlPath !== undefined) {
    const fromYaml = getByPath(operator, field.yamlPath);
    if (fromYaml !== undefined && fromYaml !== null && fromYaml !== "") return fromYaml;
  }
  const fromEnv = legacyEnv[field.key];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return undefined;
}

function resolveMode(
  operator: unknown,
  legacyEnv: Readonly<Record<string, string | undefined>>,
): ProxyMode {
  const modeRaw = getByPath(operator, "proxy.mode");
  const mode = asString(modeRaw)?.trim().toLowerCase();
  if (mode === "caddy" || mode === "direct") return mode;
  const caddy = asBoolean(getByPath(operator, "proxy.caddy"));
  if (caddy !== undefined) return caddy ? "caddy" : "direct";
  const legacy = asBoolean(legacyEnv.USE_CADDY);
  if (legacy !== undefined) return legacy ? "caddy" : "direct";
  return "caddy";
}

export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const operator = isRecord(input.operator) ? input.operator : {};
  const legacyEnv = input.legacyEnv ?? {};
  const issues: ConfigIssue[] = [];
  const values: Record<string, ConfigValue> = {};
  const mode = resolveMode(operator, legacyEnv);

  for (const field of CONFIG_FIELDS) {
    if (field.derived === true) continue;
    let raw = rawFor(field, operator, legacyEnv);
    if (raw === undefined && field.key === "TRUST_PROXY") {
      raw = mode === "caddy";
    }
    if (raw === undefined) {
      if (field.default !== undefined) values[field.key] = field.default;
      continue;
    }
    const value = coerceValue(field, raw, issues);
    if (value === undefined) continue;
    if (typeof value === "string") validateStringConstraints(field, value, issues);
    values[field.key] = value;
  }

  if (fieldMissing(values, "MONGO_USER")) requireField("MONGO_USER", issues);
  if (fieldMissing(values, "MONGO_PASS")) requireField("MONGO_PASS", issues);
  if (fieldMissing(values, "DOMAIN")) requireField("DOMAIN", issues);
  if (fieldMissing(values, "ADMIN_EMAIL")) requireField("ADMIN_EMAIL", issues);
  if (fieldMissing(values, "JWT_SECRET")) requireField("JWT_SECRET", issues);

  const mongoUser = asString(values.MONGO_USER) ?? "";
  const mongoPass = asString(values.MONGO_PASS) ?? "";
  values.MONGO_USER_URI = uriEncode(mongoUser);
  values.MONGO_PASS_URI = uriEncode(mongoPass);

  const dbName = asString(values.MONGODB_DB) ?? "tokenpanel";
  const mongoUriOverride = asString(values.MONGODB_URI);
  if (mongoUriOverride !== undefined && mongoUriOverride.length > 0) {
    values.MONGODB_URI = mongoUriOverride;
  } else {
    const host = asString(getByPath(operator, "database.host")) ?? "mongo";
    values.MONGODB_URI =
      `mongodb://${asString(values.MONGO_USER_URI)}:${asString(values.MONGO_PASS_URI)}` +
      `@${host}:27017/${dbName}?authSource=admin&directConnection=true`;
  }

  const allowWeak = asBoolean(values.ALLOW_WEAK_JWT_SECRET) === true;
  const jwt = asString(values.JWT_SECRET) ?? "";
  if (jwt.length > 0 && jwt.length < MIN_JWT_SECRET_LEN && !allowWeak) {
    issues.push({
      key: "JWT_SECRET",
      yamlPath: "api.jwtSecret",
      reason: `must be at least ${MIN_JWT_SECRET_LEN} characters`,
    });
  }

  values.USE_CADDY = mode === "caddy";

  if (issues.length > 0) throw new ConfigResolutionError(issues);

  const env: Record<string, string> = {};
  const apiEnv: Record<string, string> = {};
  const composeVars: Record<string, string> = {};

  for (const field of CONFIG_FIELDS) {
    const value = values[field.key];
    if (value === undefined) continue;
    const serialized = serialize(field, value);
    env[field.key] = serialized;
    if (field.scope === "api" || field.scope === "shared") {
      apiEnv[field.key] = serialized;
    }
    if (field.scope === "deploy" || field.scope === "shared") {
      composeVars[field.key] = serialized;
    }
  }

  composeVars.USE_CADDY = mode === "caddy" ? "y" : "n";

  return Object.freeze({ mode, values, env, apiEnv, composeVars });
}

function fieldMissing(values: Record<string, ConfigValue>, key: string): boolean {
  const v = values[key];
  return v === undefined || v === "";
}

function requireField(key: string, issues: ConfigIssue[]): void {
  issues.push({ key, reason: "required" });
}

function serialize(field: ConfigField, value: ConfigValue): string {
  if (field.kind === "boolean") {
    const b = value === true || value === "true" || value === "y";
    return field.booleanFormat === "yn" ? (b ? "y" : "n") : b ? "true" : "false";
  }
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

export function migrateLegacyEnv(
  legacyEnv: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (path: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    const parts = path.split(".");
    let current = out;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (part === undefined) return;
      if (!isRecord(current[part])) current[part] = {};
      const next = current[part];
      if (!isRecord(next)) return;
      current = next;
    }
    const last = parts[parts.length - 1];
    if (last !== undefined) current[last] = value;
  };

  set("domain", legacyEnv.DOMAIN);
  set("adminEmail", legacyEnv.ADMIN_EMAIL);
  set("timezone", legacyEnv.TZ);
  set("database.user", legacyEnv.MONGO_USER);
  set("database.password", legacyEnv.MONGO_PASS);
  set("database.name", legacyEnv.MONGODB_DB);
  set("api.jwtSecret", legacyEnv.JWT_SECRET);

  const useCaddy = asBoolean(legacyEnv.USE_CADDY);
  if (useCaddy !== undefined) {
    set("proxy.mode", useCaddy ? "caddy" : "direct");
  }
  const apiPort = asInteger(legacyEnv.API_PORT);
  if (apiPort !== undefined) set("proxy.apiPort", apiPort);
  const trustProxy = asBoolean(legacyEnv.TRUST_PROXY);
  if (trustProxy !== undefined) set("proxy.trustProxy", trustProxy);
  const trustCloudflare = asBoolean(legacyEnv.TRUST_CLOUDFLARE);
  if (trustCloudflare !== undefined) set("proxy.trustCloudflare", trustCloudflare);
  const trustedProxies = asStringArray(legacyEnv.TRUSTED_PROXIES);
  if (trustedProxies !== undefined && trustedProxies.length > 0) {
    set("proxy.trustedProxies", trustedProxies);
  }
  const cors = asStringArray(legacyEnv.CORS_ORIGINS);
  if (cors !== undefined && cors.length > 0) set("api.corsOrigins", cors);

  set("smtp.host", legacyEnv.SMTP_HOST);
  const smtpPort = asInteger(legacyEnv.SMTP_PORT);
  if (smtpPort !== undefined) set("smtp.port", smtpPort);
  set("smtp.user", legacyEnv.SMTP_USER);
  set("smtp.pass", legacyEnv.SMTP_PASS);
  set("smtp.from", legacyEnv.SMTP_FROM);

  const csp = asStringArray(legacyEnv.CSP_CONNECT_SRC);
  if (csp !== undefined && csp.length > 0) set("csp.connectSrc", csp);

  return out;
}
