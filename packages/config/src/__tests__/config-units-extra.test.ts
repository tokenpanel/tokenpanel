import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigResolutionError,
  OPERATIONAL_DEFAULTS,
  buildManifest,
  checkPolicy,
  diffManifests,
  fieldByKey,
  fieldsByScope,
  formatEnvValue,
  getByPath,
  migrateLegacyEnv,
  parseEnvFile,
  renderDeployment,
  requiredKeys,
  resolveConfig,
  secretKeys,
  allowedKeys,
  allowedKeysTxt,
  substituteTemplate,
  uriEncode,
  type RenderResult,
  type ManifestField,
  type ReleaseManifest,
} from "../index.ts";

const SECRET = "xK9mP2vQ7nR4sT8wY1zA5bC3dE6fG0hJ";

function operator() {
  return {
    domain: "panel.example.com",
    adminEmail: "admin@example.com",
    database: { user: "tokenpanel", password: "secret pass@word", name: "tokenpanel" },
    api: { jwtSecret: SECRET },
  };
}

function issueKeys(error: unknown): string[] {
  if (!(error instanceof ConfigResolutionError)) throw error;
  return error.issues.map((issue) => issue.key);
}


function issueReasons(error: unknown): string[] {
  if (!(error instanceof ConfigResolutionError)) throw error;
  return error.issues.map((issue) => issue.reason);
}

function withFields(fields: readonly ManifestField[]): ReleaseManifest {
  return { schema: 1, minManagerVersion: "0.1.0", fields };
}

function manifestField(key: string, extra: Partial<ManifestField> = {}): ManifestField {
  return {
    key,
    kind: "string",
    scope: "api",
    required: false,
    secret: false,
    derived: false,
    ...extra,
  };
}

describe("fields registry", () => {
  test("fieldByKey resolves known keys and misses unknown ones", () => {
    const domain = fieldByKey("DOMAIN");
    expect(domain).toBeDefined();
    expect(domain?.kind).toBe("domain");
    expect(domain?.scope).toBe("deploy");
    expect(domain?.required).toBe(true);
    expect(fieldByKey("NO_SUCH_FIELD")).toBeUndefined();
  });

  test("fieldsByScope partitions the registry", () => {
    const scopes = ["api", "deploy", "shared"] as const;
    const total = scopes.reduce((sum, scope) => sum + fieldsByScope(scope).length, 0);
    expect(fieldsByScope("api").every((field) => field.scope === "api")).toBe(true);
    expect(fieldsByScope("shared").map((f) => f.key)).toContain("TRUST_PROXY");
    expect(total).toBe(32);
  });

  test("operational defaults match documented values", () => {
    expect(OPERATIONAL_DEFAULTS).toEqual({
      settlementReconcileIntervalMs: 15_000,
      settlementReconcileBatchSizeCount: 20,
      settlementReconcileInitialDelayMs: 3_000,
      providerHttpTimeoutMs: 120_000,
      catalogCacheTtlMs: 600_000,
      workerConcurrencyCount: 1,
      shutdownTimeoutMs: 10_000,
    });
  });
});

describe("resolveConfig per-kind coercion", () => {
  test("MONGODB_DB accepts conforming names", () => {
    const resolved = resolveConfig({
      operator: { ...operator(), database: { ...operator().database, name: "Token_Panel-2" } },
    });
    expect(resolved.values.MONGODB_DB).toBe("Token_Panel-2");
  });

  test("MONGODB_DB rejects pattern violations", () => {
    try {
      resolveConfig({
        operator: { ...operator(), database: { ...operator().database, name: "token panel!" } },
      });
      expect.unreachable();
    } catch (e) {
      expect(issueReasons(e)).toContain("must match ^[A-Za-z0-9_-]+$");
    }
  });

  test("MONGODB_DB rejects names over 63 chars", () => {
    try {
      resolveConfig({
        operator: { ...operator(), database: { ...operator().database, name: "a".repeat(64) } },
      });
      expect.unreachable();
    } catch (e) {
      expect(issueReasons(e)).toContain("must be at most 63 characters");
    }
  });

  test("API_PORT below min fails", () => {
    try {
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: 0 } } });
      expect.unreachable();
    } catch (e) {
      expect(issueReasons(e)).toContain("must be >= 1");
    }
  });

  test("API_PORT above max fails", () => {
    try {
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: 65536 } } });
      expect.unreachable();
    } catch (e) {
      expect(issueReasons(e)).toContain("must be <= 65535");
    }
  });

  test("API_PORT non-integer fails", () => {
    try {
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: 8080.5 } } });
      expect.unreachable();
    } catch (e) {
      expect(issueReasons(e)).toContain("must be an integer");
    }
  });

  test("NODE_ENV outside choices fails", () => {
    try {
      resolveConfig({ operator: { ...operator(), api: { jwtSecret: SECRET, environment: "staging" } } });
      expect.unreachable();
    } catch (e) {
      expect(issueReasons(e)).toContain("must be one of: development, test, production");
    }
  });

  test("NODE_ENV inside choices resolves and serializes", () => {
    const resolved = resolveConfig({
      operator: { ...operator(), api: { jwtSecret: SECRET, environment: "development" } },
    });
    expect(resolved.apiEnv.NODE_ENV).toBe("development");
  });

  test("list kinds accept arrays and reject scalars", () => {
    const arrayed = resolveConfig({
      operator: {
        ...operator(),
        api: { jwtSecret: SECRET, corsOrigins: ["https://a.example.com", "https://b.example.com"] },
        proxy: { trustedProxies: ["10.0.0.1", "10.0.0.2"] },
        csp: { connectSrc: ["wss://relay.example.com"] },
      },
    });
    expect(arrayed.values.CORS_ORIGINS).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(arrayed.values.TRUSTED_PROXIES).toEqual(["10.0.0.1", "10.0.0.2"]);
    const scalar = (() => {
      try {
        resolveConfig({ operator: { ...operator(), api: { jwtSecret: SECRET, corsOrigins: 12345 } } });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(scalar).toBeInstanceOf(ConfigResolutionError);
    expect(issueReasons(scalar)).toContain("must be a list");

    const commaString = resolveConfig({
      operator: { ...operator(), api: { jwtSecret: SECRET, corsOrigins: "https://x.example.com" } },
    });
    expect(commaString.values.CORS_ORIGINS).toEqual(["https://x.example.com"]);
  });
});

describe("resolve helpers", () => {
  test("getByPath resolves nested keys and misses missing ones", () => {
    const src = { a: { b: { c: 42 } }, top: "v" };
    expect(getByPath(src, "a.b.c")).toBe(42);
    expect(getByPath(src, "top")).toBe("v");
    expect(getByPath(src, "a.b.missing")).toBeUndefined();
    expect(getByPath(src, "top.deep.deeper")).toBeUndefined();
    expect(getByPath(null, "a")).toBeUndefined();
    expect(getByPath("string", "length")).toBeUndefined();
  });

  test("uriEncode escapes reserved URI characters", () => {
    expect(uriEncode("secret pass@word")).toBe("secret%20pass%40word");
    expect(uriEncode("p!$&'()*+,;=:#/ ?")).toBe("p%21%24%26%27%28%29%2A%2B%2C%3B%3D%3A%23%2F%20%3F");
    expect(uriEncode("safe-alpha_1.~")).toBe("safe-alpha_1.~");
  });

  test("boolean coercion accepts all documented spellings", () => {
    const truthy = ["1", "true", "yes", "on", "y", "YES", "True"];
    const falsy = ["0", "false", "no", "off", "n", "NO", "False"];
    for (const spelling of truthy) {
      const resolved = resolveConfig({
        operator: { ...operator(), api: { jwtSecret: SECRET, allowWeakJwtSecret: spelling } },
      });
      expect(resolved.values.ALLOW_WEAK_JWT_SECRET).toBe(true);
    }
    for (const spelling of falsy) {
      const resolved = resolveConfig({
        operator: { ...operator(), api: { jwtSecret: SECRET, allowWeakJwtSecret: spelling } },
      });
      expect(resolved.values.ALLOW_WEAK_JWT_SECRET).toBe(false);
    }
  });

  test("boolean coercion rejects non-boolean spellings", () => {
    try {
      resolveConfig({ operator: { ...operator(), api: { jwtSecret: SECRET, allowWeakJwtSecret: "maybe" } } });
      expect.unreachable();
    } catch (e) {
      expect(issueReasons(e)).toContain("must be a boolean");
    }
  });

  test("asInteger non-digit strings are rejected", () => {
    try {
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: "80x80" } } });
      expect.unreachable();
    } catch (e) {
      expect(issueReasons(e)).toContain("must be an integer");
    }
  });

  test("stringList accepts comma strings and arrays", () => {
    const fromString = resolveConfig({
      operator: { ...operator(), csp: { connectSrc: " https://a.example.com , https://b.example.com " } },
    });
    expect(fromString.values.CSP_CONNECT_SRC).toEqual(["https://a.example.com", "https://b.example.com"]);

    const fromArray = resolveConfig({
      operator: { ...operator(), csp: { connectSrc: ["https://c.example.com"] } },
    });
    expect(fromArray.values.CSP_CONNECT_SRC).toEqual(["https://c.example.com"]);
  });

  test("validateStringConstraints enforces choices on NODE_ENV via api.environment", () => {
    try {
      resolveConfig({
        operator: { ...operator(), api: { jwtSecret: SECRET, environment: "staging" } },
      });
      expect.unreachable();
    } catch (e) {
      expect(issueKeys(e)).toContain("NODE_ENV");
      expect(issueReasons(e)).toContain("must be one of: development, test, production");
    }
  });

  test("operator database.uri does not override the derived MONGODB_URI", () => {
    const resolved = resolveConfig({
      operator: {
        ...operator(),
        database: { ...operator().database, uri: "mongodb+srv://custom.example.com/tokenpanel" },
      },
    });
    expect(resolved.values.MONGODB_URI).toBe(
      "mongodb://tokenpanel:secret%20pass%40word@mongo:27017/tokenpanel?authSource=admin&directConnection=true",
    );
  });
});

describe("migrateLegacyEnv", () => {
  test("maps core keys to operator paths", () => {
    const mapped = migrateLegacyEnv({
      DOMAIN: "legacy.example.com",
      ADMIN_EMAIL: "legacy@example.com",
      TZ: "Europe/Berlin",
      MONGO_USER: "u",
      MONGO_PASS: "p",
      MONGODB_DB: "tokenpanel",
      JWT_SECRET: SECRET,
      API_PORT: "8080",
      TRUST_PROXY: "true",
      TRUST_CLOUDFLARE: "false",
      TRUSTED_PROXIES: "10.0.0.1, 10.0.0.2",
      CORS_ORIGINS: "https://a.example.com",
      USE_CADDY: "n",
    });
    expect(mapped.domain).toBe("legacy.example.com");
    expect(mapped.adminEmail).toBe("legacy@example.com");
    expect(mapped.timezone).toBe("Europe/Berlin");
    expect((mapped.database as Record<string, unknown>).user).toBe("u");
    expect((mapped.database as Record<string, unknown>).password).toBe("p");
    expect((mapped.database as Record<string, unknown>).name).toBe("tokenpanel");
    expect((mapped.api as Record<string, unknown>).jwtSecret).toBe(SECRET);
    expect((mapped.proxy as Record<string, unknown>).mode).toBe("direct");
    expect((mapped.proxy as Record<string, unknown>).apiPort).toBe(8080);
    expect((mapped.proxy as Record<string, unknown>).trustProxy).toBe(true);
    expect((mapped.proxy as Record<string, unknown>).trustCloudflare).toBe(false);
    expect((mapped.proxy as Record<string, unknown>).trustedProxies).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect((mapped.api as Record<string, unknown>).corsOrigins).toEqual(["https://a.example.com"]);
  });

  test("maps smtp/csp/trustedProxies legacy branches", () => {
    const mapped = migrateLegacyEnv({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "2587",
      SMTP_USER: "mailer",
      SMTP_PASS: "mailpass",
      SMTP_FROM: "panel@example.com",
      CSP_CONNECT_SRC: "wss://relay.example.com",
    });
    expect((mapped.smtp as Record<string, unknown>).host).toBe("smtp.example.com");
    expect((mapped.smtp as Record<string, unknown>).port).toBe(2587);
    expect((mapped.smtp as Record<string, unknown>).user).toBe("mailer");
    expect((mapped.smtp as Record<string, unknown>).pass).toBe("mailpass");
    expect((mapped.smtp as Record<string, unknown>).from).toBe("panel@example.com");
    expect((mapped.csp as Record<string, unknown>).connectSrc).toEqual(["wss://relay.example.com"]);
  });

  test("empty and junk values are skipped", () => {
    const mapped = migrateLegacyEnv({
      DOMAIN: "",
      ADMIN_EMAIL: undefined,
      API_PORT: "not-a-port",
      SMTP_PORT: "",
    });
    expect(mapped.domain).toBeUndefined();
    expect(mapped.adminEmail).toBeUndefined();
    expect(mapped.proxy).toBeUndefined();
    expect(mapped.smtp).toBeUndefined();
  });
});

describe("policy", () => {
  function baseline(): ReleaseManifest {
    return buildManifest("0.1.0");
  }

  test("kind change is an error", () => {
    const before = baseline();
    const fields = before.fields.map((f) =>
      f.key === "SMTP_HOST" ? { ...f, kind: "secret" as const } : f,
    );
    const issues = checkPolicy(before, { ...before, fields });
    const hit = issues.find((i) => i.key === "SMTP_HOST" && i.level === "error");
    expect(hit?.message).toContain("kind changed");
  });

  test("secret flag change is an error", () => {
    const before = baseline();
    const fields = before.fields.map((f) =>
      f.key === "SMTP_HOST" ? { ...f, secret: !f.secret } : f,
    );
    const issues = checkPolicy(before, { ...before, fields });
    const hit = issues.find((i) => i.key === "SMTP_HOST" && i.level === "error");
    expect(hit?.message).toContain("secret flag changed");
  });

  test("optional becoming required without default is an error", () => {
    const before = baseline();
    const fields = before.fields.map((f) =>
      f.key === "SMTP_HOST" ? { ...f, required: true } : f,
    );
    const issues = checkPolicy(before, { ...before, fields });
    const hit = issues.find((i) => i.key === "SMTP_HOST" && i.level === "error");
    expect(hit?.message).toContain("optional config became required");
  });

  test("default change is a warning", () => {
    const before = baseline();
    const fields = before.fields.map((f) =>
      f.key === "API_PORT" ? { ...f, default: 8080 } : f,
    );
    const issues = checkPolicy(before, { ...before, fields });
    const hit = issues.find((i) => i.key === "API_PORT" && i.level === "warn");
    expect(hit?.message).toContain("default changed");
    expect(hit?.message).toContain("3000");
    expect(hit?.message).toContain("8080");
  });

  test("validation change is a warning", () => {
    const before = baseline();
    const fields = before.fields.map((f) =>
      f.key === "API_PORT" ? { ...f, validation: { min: 1024, max: 65535 } } : f,
    );
    const issues = checkPolicy(before, { ...before, fields });
    const hit = issues.find((i) => i.key === "API_PORT" && i.level === "warn");
    expect(hit?.message).toContain("validation rules changed");
  });

  test("diffManifests filters since prop from changedProps", () => {
    const before = withFields([manifestField("NEW_KEY", { since: "0.1.0" })]);
    const after = withFields([manifestField("NEW_KEY", { since: "0.2.0" })]);
    const diff = diffManifests(before, after);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  test("diffManifests keeps real prop changes", () => {
    const before = withFields([manifestField("CHANGED")]);
    const after = withFields([manifestField("CHANGED", { yamlPath: "api.changed" })]);
    const diff = diffManifests(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.changedProps).toEqual(["yamlPath"]);
  });

  test("diffManifests reports added and removed keys", () => {
    const before = withFields([manifestField("OLD_KEY")]);
    const after = withFields([manifestField("NEW_KEY")]);
    const diff = diffManifests(before, after);
    expect(diff.added.map((f) => f.key)).toEqual(["NEW_KEY"]);
    expect(diff.removed.map((f) => f.key)).toEqual(["OLD_KEY"]);
    expect(diff.changed).toHaveLength(0);
  });
});

describe("parseEnvFile", () => {
  test("parses plain values, skips comments and blanks", () => {
    const parsed = parseEnvFile(
      ["# comment line", "", "PLAIN=value", "  # indented comment", "SPACED=  padded  ", ""].join("\n"),
    );
    expect(parsed.PLAIN).toBe("value");
    expect(parsed.SPACED).toBe("padded");
    expect(Object.keys(parsed)).toHaveLength(2);
  });

  test("strips matching single and double quotes", () => {
    const parsed = parseEnvFile(['A="double quoted"', "B='single quoted'", "C=unquoted"].join("\n"));
    expect(parsed.A).toBe("double quoted");
    expect(parsed.B).toBe("single quoted");
    expect(parsed.C).toBe("unquoted");
  });

  test("skips malformed keys", () => {
    const parsed = parseEnvFile(
      ["=nokey", "1BAD=x", "BAD-KEY=x", "GOOD_KEY=ok", "=x", "NO_EQUALS_SIGN", "=x"].join("\n"),
    );
    expect(parsed).toEqual({ GOOD_KEY: "ok" });
  });
});

describe("substituteTemplate", () => {
  test("substitutes present vars", () => {
    expect(substituteTemplate("host=${HOST} port=${PORT}", { HOST: "mongo", PORT: "27017" })).toBe(
      "host=mongo port=27017",
    );
  });

  test("falls back to ${VAR:-default} when var missing", () => {
    expect(substituteTemplate("db=${DB:-tokenpanel}", {})).toBe("db=tokenpanel");
    expect(substituteTemplate("db=${DB:-fallback}", { DB: "custom" })).toBe("db=custom");
    expect(substituteTemplate("empty=${EMPTY:-x}", { EMPTY: "" })).toBe("empty=");
  });

  test("leaves unresolved vars intact and $$ escapes literals", () => {
    expect(substituteTemplate("stay=${MISSING}", {})).toBe("stay=${MISSING}");
    expect(substituteTemplate("$$${VAR}", { VAR: "v" })).toBe("$$${VAR}");
    expect(substituteTemplate("$${ESCAPED}", { ESCAPED: "x" })).toBe("$${ESCAPED}");
  });
});

describe("manifest helpers", () => {
  test("requiredKeys, secretKeys, allowedKeys behave on the built manifest", () => {
    const manifest = buildManifest("0.1.0");
    const required = requiredKeys(manifest);
    expect(required).toContain("JWT_SECRET");
    expect(required).not.toContain("MONGO_PASS_URI");
    const secrets = secretKeys(manifest);
    expect(secrets).toContain("JWT_SECRET");
    expect(secrets).toContain("MONGO_PASS_URI");
    expect(secrets).not.toContain("DOMAIN");
    const allowed = allowedKeys(manifest);
    expect(allowed.length).toBe(manifest.fields.length);
    expect(allowed).toContain("USE_CADDY");
  });

  test("allowedKeysTxt ends with newline and lists every key", () => {
    const txt = allowedKeysTxt(buildManifest("0.1.0"));
    expect(txt.endsWith("\n")).toBe(true);
    const keys = txt.split("\n").filter((line) => line.length > 0);
    expect(keys).toContain("JWT_SECRET");
  });

  test("formatEnvValue formats strings, numbers, booleans and arrays", () => {
    expect(formatEnvValue("plain")).toBe("plain");
    expect(formatEnvValue(8080)).toBe("8080");
    expect(formatEnvValue(true)).toBe("true");
    expect(formatEnvValue(["a", "b"])).toBe("a,b");
    expect(formatEnvValue([])).toBe("");
  });
});

describe("configHash determinism and redaction", () => {
  test("same inputs produce identical hash", () => {
    const a = render();
    const b = render();
    expect(a.configHash).toBe(b.configHash);
    expect(a.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hash changes when non-secret value changes, stable when only secret differs", () => {
    const base = render();
    const changedDomain = render({ domain: "other.example.com" });
    const changedSecret = render({ jwtSecret: "DIFFERENTsecretDIFFERENTsecret123456" });
    expect(changedDomain.configHash).not.toBe(base.configHash);
    expect(changedSecret.configHash).toBe(base.configHash);
  });
});

function render(overrides: { domain?: string; jwtSecret?: string } = {}): RenderResult {
  const dir = mkdtempSync(join(tmpdir(), "tokenpanel-hash-"));
  try {
    const operatorPath = join(dir, "tokenpanel.yml");
    fsWriteFileSync(
      operatorPath,
      [
        `domain: ${overrides.domain ?? "panel.example.com"}`,
        "adminEmail: admin@example.com",
        "database:",
        "  user: tokenpanel",
        "  password: secret",
        "api:",
        `  jwtSecret: ${overrides.jwtSecret ?? SECRET}`,
        "",
      ].join("\n"),
    );
    return renderDeployment({
      operatorPath,
      templatesDir: join(import.meta.dir, "..", "..", "..", "..", "manager", "templates"),
      outDir: join(dir, "generated"),
      dataDir: "/var/tokenpanel/shared",
      generatedConfigDir: join(dir, "generated"),
      managerVersion: "0.1.0",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
