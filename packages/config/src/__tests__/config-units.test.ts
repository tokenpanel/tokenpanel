import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FIELDS,
  ConfigResolutionError,
  MIN_JWT_SECRET_LEN,
  OPERATIONAL_DEFAULTS,
  allowedKeys,
  allowedKeysTxt,
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
  substituteTemplate,
  uriEncode,
  type ConfigIssue,
  type ManifestField,
  type ReleaseManifest,
} from "../index.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const TEMPLATES = join(ROOT, "manager", "templates");
const SECRET = "xK9mP2vQ7nR4sT8wY1zA5bC3dE6fG0hJ";
const OTHER_SECRET = "yL0nQ3wR8sT9xU2zA6bD4eF7gH1iJ5kN";

function operator() {
  return {
    domain: "panel.example.com",
    adminEmail: "admin@example.com",
    database: { user: "tokenpanel", password: "secret pass@word", name: "tokenpanel" },
    api: { jwtSecret: SECRET },
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tokenpanel-config-units-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function issuesOf(run: () => unknown): readonly ConfigIssue[] {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigResolutionError);
    return (e as ConfigResolutionError).issues;
  }
  throw new Error("expected ConfigResolutionError");
}

describe("field lookups", () => {
  test("fieldByKey finds known keys and rejects unknown ones", () => {
    const jwt = fieldByKey("JWT_SECRET");
    expect(jwt?.key).toBe("JWT_SECRET");
    expect(jwt?.kind).toBe("secret");
    expect(jwt?.scope).toBe("api");
    expect(jwt?.required).toBe(true);
    expect(jwt?.secret).toBe(true);
    expect(jwt?.validation).toEqual({ minLength: MIN_JWT_SECRET_LEN });
    expect(fieldByKey("TOTALLY_UNKNOWN")).toBeUndefined();
  });

  test("fieldsByScope returns only fields of the requested scope", () => {
    const api = fieldsByScope("api");
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((f) => f.scope === "api")).toBe(true);
    expect(api.map((f) => f.key)).toContain("JWT_SECRET");
    expect(fieldsByScope("deploy").map((f) => f.key)).toContain("DOMAIN");
    expect(fieldsByScope("shared").map((f) => f.key)).toContain("TRUSTED_PROXIES");
    expect(fieldsByScope("nonexistent" as never)).toHaveLength(0);
  });

  test("fieldsByScope partitions CONFIG_FIELDS without gaps or duplicate keys", () => {
    const total = (["api", "deploy", "shared"] as const).reduce(
      (n, scope) => n + fieldsByScope(scope).length,
      0,
    );
    expect(total).toBe(CONFIG_FIELDS.length);
    expect(new Set(CONFIG_FIELDS.map((f) => f.key)).size).toBe(CONFIG_FIELDS.length);
  });
});

describe("OPERATIONAL_DEFAULTS", () => {
  test("holds the documented operational defaults", () => {
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

  test("runtime-keyed fields wire their defaults to the shared constants", () => {
    const runtimeKeys = CONFIG_FIELDS.flatMap((f) => (f.runtimeKey ? [f.runtimeKey] : []));
    expect(runtimeKeys.slice().sort()).toEqual(Object.keys(OPERATIONAL_DEFAULTS).sort());
    for (const field of CONFIG_FIELDS) {
      if (field.runtimeKey === undefined) continue;
      const key = field.runtimeKey as keyof typeof OPERATIONAL_DEFAULTS;
      expect(field.default).toBe(OPERATIONAL_DEFAULTS[key]);
    }
  });

  test("resolution falls back to the operational defaults", () => {
    const resolved = resolveConfig({ operator: operator() });
    expect(resolved.values.WORKER_CONCURRENCY).toBe(OPERATIONAL_DEFAULTS.workerConcurrencyCount);
    expect(resolved.env.CATALOG_CACHE_TTL_MS).toBe(String(OPERATIONAL_DEFAULTS.catalogCacheTtlMs));
    expect(resolved.env.SETTLEMENT_RECONCILE_INTERVAL_MS).toBe(
      String(OPERATIONAL_DEFAULTS.settlementReconcileIntervalMs),
    );
  });
});

describe("MONGODB_DB constraints", () => {
  test("rejects names violating pattern and maxLength in one pass", () => {
    const issues = issuesOf(() =>
      resolveConfig({
        operator: {
          ...operator(),
          database: { ...operator().database, name: "bad name".concat("x".repeat(60)) },
        },
      }),
    );
    expect(issues).toContainEqual({
      key: "MONGODB_DB",
      yamlPath: "database.name",
      reason: "must be at most 63 characters",
    });
    expect(issues).toContainEqual({
      key: "MONGODB_DB",
      yamlPath: "database.name",
      reason: "must match ^[A-Za-z0-9_-]+$",
    });
  });

  test("accepts names matching the pattern within maxLength", () => {
    const ok = resolveConfig({
      operator: { ...operator(), database: { ...operator().database, name: "Custom_DB-01" } },
    });
    expect(ok.env.MONGODB_DB).toBe("Custom_DB-01");
    expect(ok.apiEnv.MONGODB_URI).toContain("/Custom_DB-01?");
  });
});

describe("integer validation via API_PORT", () => {
  test("rejects below-min, above-max, and non-integer values", () => {
    const below = issuesOf(() =>
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: 0 } } }),
    );
    expect(below).toContainEqual({
      key: "API_PORT",
      yamlPath: "proxy.apiPort",
      reason: "must be >= 1",
    });

    const above = issuesOf(() =>
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: 65536 } } }),
    );
    expect(above).toContainEqual({
      key: "API_PORT",
      yamlPath: "proxy.apiPort",
      reason: "must be <= 65535",
    });

    const alpha = issuesOf(() =>
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: "80x8" } } }),
    );
    expect(alpha).toContainEqual({
      key: "API_PORT",
      yamlPath: "proxy.apiPort",
      reason: "must be an integer",
    });

    const float = issuesOf(() =>
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: 8080.5 } } }),
    );
    expect(float).toContainEqual({
      key: "API_PORT",
      yamlPath: "proxy.apiPort",
      reason: "must be an integer",
    });
  });

  test("accepts boundary ports and digit strings", () => {
    expect(resolveConfig({ operator: { ...operator(), proxy: { apiPort: 1 } } }).env.API_PORT).toBe(
      "1",
    );
    expect(
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: 65535 } } }).env.API_PORT,
    ).toBe("65535");
    expect(
      resolveConfig({ operator: { ...operator(), proxy: { apiPort: "8080" } } }).env.API_PORT,
    ).toBe("8080");
  });
});

describe("NODE_ENV choices", () => {
  test("rejects values outside the choice list", () => {
    const issues = issuesOf(() =>
      resolveConfig({
        operator: { ...operator(), api: { jwtSecret: SECRET, environment: "staging" } },
      }),
    );
    expect(issues).toContainEqual({
      key: "NODE_ENV",
      yamlPath: "api.environment",
      reason: "must be one of: development, test, production",
    });
  });

  test("accepts every listed choice", () => {
    for (const choice of ["development", "test", "production"]) {
      const ok = resolveConfig({
        operator: { ...operator(), api: { jwtSecret: SECRET, environment: choice } },
      });
      expect(ok.env.NODE_ENV).toBe(choice);
    }
  });
});

describe("list kinds", () => {
  test("accept arrays for originList, proxyList, and stringList", () => {
    const ok = resolveConfig({
      operator: {
        ...operator(),
        api: { jwtSecret: SECRET, corsOrigins: ["https://a.example.com", "https://b.example.com"] },
        proxy: { trustedProxies: ["10.0.0.1", "10.0.0.2"] },
        csp: { connectSrc: ["wss://c.example.com"] },
      },
    });
    expect(ok.env.CORS_ORIGINS).toBe("https://a.example.com,https://b.example.com");
    expect(ok.env.TRUSTED_PROXIES).toBe("10.0.0.1,10.0.0.2");
    expect(ok.env.CSP_CONNECT_SRC).toBe("wss://c.example.com");
  });

  test("reject non-string scalars", () => {
    const num = issuesOf(() =>
      resolveConfig({ operator: { ...operator(), api: { jwtSecret: SECRET, corsOrigins: 42 } } }),
    );
    expect(num).toContainEqual({
      key: "CORS_ORIGINS",
      yamlPath: "api.corsOrigins",
      reason: "must be a list",
    });

    const bool = issuesOf(() =>
      resolveConfig({ operator: { ...operator(), proxy: { trustedProxies: false } } }),
    );
    expect(bool).toContainEqual({
      key: "TRUSTED_PROXIES",
      yamlPath: "proxy.trustedProxies",
      reason: "must be a list",
    });
  });

  test("split comma strings, trim parts, and drop empties", () => {
    const ok = resolveConfig({
      operator: {
        ...operator(),
        csp: { connectSrc: "wss://a.example.com,, wss://b.example.com ," },
      },
    });
    expect(ok.env.CSP_CONNECT_SRC).toBe("wss://a.example.com,wss://b.example.com");
  });
});

describe("resolve helpers", () => {
  test("getByPath reads nested values and returns undefined for missing or non-record paths", () => {
    const source = { a: { b: { c: "deep" } }, n: null, list: ["x"] };
    expect(getByPath(source, "a.b.c")).toBe("deep");
    expect(getByPath(source, "a")).toEqual({ b: { c: "deep" } });
    expect(getByPath(source, "a.b.x")).toBeUndefined();
    expect(getByPath(source, "a.x.y")).toBeUndefined();
    expect(getByPath(source, "n.deep")).toBeUndefined();
    expect(getByPath(source, "list.0")).toBeUndefined();
    expect(getByPath("scalar", "a")).toBeUndefined();
    expect(getByPath(null, "a")).toBeUndefined();
    expect(getByPath(undefined, "a")).toBeUndefined();
  });

  test("uriEncode percent-encodes URI-hostile characters", () => {
    expect(uriEncode("plain")).toBe("plain");
    expect(uriEncode("p@ss word")).toBe("p%40ss%20word");
    expect(uriEncode("a/b?c=d")).toBe("a%2Fb%3Fc%3Dd");
    expect(uriEncode("!*'()")).toBe("%21%2A%27%28%29");
    expect(uriEncode("")).toBe("");
  });
});

describe("value coercion", () => {
  test("accepts every truthy boolean spelling", () => {
    for (const spelling of ["1", "true", "yes", "on", "y"]) {
      const r = resolveConfig({ operator: operator(), legacyEnv: { TRUST_CLOUDFLARE: spelling } });
      expect(r.env.TRUST_CLOUDFLARE).toBe("true");
    }
  });

  test("accepts every falsy boolean spelling", () => {
    for (const spelling of ["0", "false", "no", "off", "n"]) {
      const r = resolveConfig({ operator: operator(), legacyEnv: { TRUST_CLOUDFLARE: spelling } });
      expect(r.env.TRUST_CLOUDFLARE).toBe("false");
    }
  });

  test("serializes yn and trueFalse formats distinctly and accepts numeric booleans", () => {
    const truthy = resolveConfig({
      operator: { ...operator(), proxy: { trustCloudflare: 1 } },
      legacyEnv: { USE_CADDY: "yes", TRUST_PROXY: "on" },
    });
    expect(truthy.mode).toBe("caddy");
    expect(truthy.env.USE_CADDY).toBe("y");
    expect(truthy.env.TRUST_PROXY).toBe("true");
    expect(truthy.env.TRUST_CLOUDFLARE).toBe("true");

    const falsy = resolveConfig({
      operator: { ...operator(), proxy: { caddy: "off" } },
      legacyEnv: { TRUST_PROXY: "0", TRUST_CLOUDFLARE: "No" },
    });
    expect(falsy.mode).toBe("direct");
    expect(falsy.env.USE_CADDY).toBe("n");
    expect(falsy.env.TRUST_PROXY).toBe("false");
    expect(falsy.env.TRUST_CLOUDFLARE).toBe("false");
  });

  test("rejects unrecognized boolean spellings", () => {
    const issues = issuesOf(() =>
      resolveConfig({ operator: { ...operator(), proxy: { trustCloudflare: "maybe" } } }),
    );
    expect(issues).toContainEqual({
      key: "TRUST_CLOUDFLARE",
      yamlPath: "proxy.trustCloudflare",
      reason: "must be a boolean",
    });
  });
});

describe("MONGODB_URI resolution", () => {
  test("generates the URI from database settings with the default host", () => {
    const resolved = resolveConfig({ operator: operator() });
    expect(resolved.apiEnv.MONGODB_URI).toBe(
      "mongodb://tokenpanel:secret%20pass%40word@mongo:27017/tokenpanel?authSource=admin&directConnection=true",
    );
  });

  test("honors database.host", () => {
    const host = resolveConfig({
      operator: { ...operator(), database: { ...operator().database, host: "db.internal" } },
    });
    expect(host.apiEnv.MONGODB_URI).toBe(
      "mongodb://tokenpanel:secret%20pass%40word@db.internal:27017/tokenpanel?authSource=admin&directConnection=true",
    );
  });

  test("always composes the URI: operator database.uri is currently ignored", () => {
    // MONGODB_URI is a derived field, so the resolve loop skips it before rawFor
    // reads database.uri; the override branch in resolve.ts is unreachable.
    const explicit = resolveConfig({
      operator: {
        ...operator(),
        database: { ...operator().database, uri: "mongodb://127.0.0.1:27017/external?tls=true" },
      },
    });
    expect(explicit.apiEnv.MONGODB_URI).toBe(
      "mongodb://tokenpanel:secret%20pass%40word@mongo:27017/tokenpanel?authSource=admin&directConnection=true",
    );
  });
});

describe("migrateLegacyEnv", () => {
  test("maps smtp, csp, and trustedProxies branches with typed values", () => {
    const out = migrateLegacyEnv({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "mailer",
      SMTP_PASS: "mail pass",
      SMTP_FROM: "noreply@example.com",
      CSP_CONNECT_SRC: "wss://a.example.com, wss://b.example.com",
      TRUSTED_PROXIES: "10.0.0.1, 10.0.0.2",
    });
    expect(out).toEqual({
      smtp: {
        host: "smtp.example.com",
        port: 587,
        user: "mailer",
        pass: "mail pass",
        from: "noreply@example.com",
      },
      csp: { connectSrc: ["wss://a.example.com", "wss://b.example.com"] },
      proxy: { trustedProxies: ["10.0.0.1", "10.0.0.2"] },
    });
  });

  test("drops empty and non-integer legacy values", () => {
    expect(
      migrateLegacyEnv({
        SMTP_HOST: "",
        CSP_CONNECT_SRC: "",
        TRUSTED_PROXIES: "",
        SMTP_PORT: "58x",
      }),
    ).toEqual({});
  });

  test("migrated operator resolves end to end", () => {
    const op = migrateLegacyEnv({
      DOMAIN: "legacy.example.com",
      ADMIN_EMAIL: "legacy@example.com",
      MONGO_USER: "u",
      MONGO_PASS: "p",
      JWT_SECRET: SECRET,
      TRUSTED_PROXIES: "10.0.0.1",
      SMTP_HOST: "smtp.example.com",
      CSP_CONNECT_SRC: "wss://c.example.com",
    });
    const resolved = resolveConfig({ operator: op });
    expect(resolved.env.TRUSTED_PROXIES).toBe("10.0.0.1");
    expect(resolved.env.SMTP_HOST).toBe("smtp.example.com");
    expect(resolved.env.CSP_CONNECT_SRC).toBe("wss://c.example.com");
    expect(resolved.env.DOMAIN).toBe("legacy.example.com");
  });
});

describe("policy rules", () => {
  function baseline(): ReleaseManifest {
    return buildManifest("0.1.0");
  }

  function withField(
    manifest: ReleaseManifest,
    key: string,
    mutate: (f: ManifestField) => ManifestField,
  ): ReleaseManifest {
    return { ...manifest, fields: manifest.fields.map((f) => (f.key === key ? mutate(f) : f)) };
  }

  test("flags a kind change as an error", () => {
    const before = baseline();
    const issues = checkPolicy(before, withField(before, "SMTP_HOST", (f) => ({ ...f, kind: "boolean" })));
    expect(issues).toContainEqual(
      expect.objectContaining({
        level: "error",
        key: "SMTP_HOST",
        message: expect.stringContaining("config kind changed from string to boolean"),
      }),
    );
  });

  test("flags a secret flag change as an error", () => {
    const before = baseline();
    const issues = checkPolicy(before, withField(before, "SMTP_HOST", (f) => ({ ...f, secret: true })));
    expect(issues).toContainEqual(
      expect.objectContaining({ level: "error", key: "SMTP_HOST", message: expect.stringContaining("secret flag changed") }),
    );
  });

  test("flags optional becoming required without a default as an error", () => {
    const before = baseline();
    const issues = checkPolicy(before, withField(before, "SMTP_HOST", (f) => ({ ...f, required: true })));
    expect(issues).toContainEqual(
      expect.objectContaining({
        level: "error",
        key: "SMTP_HOST",
        message: expect.stringContaining("optional config became required without a default"),
      }),
    );
  });

  test("optional becoming required with a default is not an error", () => {
    const before = baseline();
    const after = withField(before, "SMTP_HOST", (f) => ({
      ...f,
      required: true,
      default: "smtp.example.com",
    }));
    const issues = checkPolicy(before, after);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(issues.some((i) => i.level === "warn" && i.key === "SMTP_HOST")).toBe(true);
  });

  test("flags a default change as a warning", () => {
    const before = baseline();
    const after = withField(before, "API_PORT", (f) => ({ ...f, default: 3001 }));
    const issues = checkPolicy(before, after);
    expect(issues).toContainEqual(
      expect.objectContaining({
        level: "warn",
        key: "API_PORT",
        message: expect.stringContaining("default changed from 3000 to 3001"),
      }),
    );
  });

  test("flags a validation change as a warning", () => {
    const before = baseline();
    const after = withField(before, "MONGODB_DB", (f) => ({
      ...f,
      validation: { maxLength: 32, pattern: "^[A-Za-z0-9_-]+$" },
    }));
    const issues = checkPolicy(before, after);
    expect(issues).toContainEqual(
      expect.objectContaining({
        level: "warn",
        key: "MONGODB_DB",
        message: expect.stringContaining("validation rules changed"),
      }),
    );
  });

  test("diffManifests reports added, removed, and changed with exact changedProps", () => {
    const before = baseline();
    const extra: ManifestField = {
      key: "NEW_OPTIONAL",
      kind: "string",
      scope: "api",
      required: false,
      secret: false,
      derived: false,
    };
    const middle = { ...before, fields: [...before.fields, extra] };
    expect(diffManifests(before, middle).added.map((f) => f.key)).toEqual(["NEW_OPTIONAL"]);
    expect(diffManifests(middle, before).removed.map((f) => f.key)).toEqual(["NEW_OPTIONAL"]);

    const after = withField(middle, "API_PORT", (f) => ({ ...f, default: 3001 }));
    const diff = diffManifests(middle, after);
    const change = diff.changed.find((c) => c.key === "API_PORT");
    expect(change?.changedProps).toEqual(["default"]);
    expect(change?.before.default).toBe(3000);
    expect(change?.after.default).toBe(3001);
    expect(diff.changed.some((c) => c.key === "NEW_OPTIONAL")).toBe(false);
  });

  test("diffManifests filters since changes but surfaces deprecatedSince changes", () => {
    const before = baseline();
    const sinceBump = checkPolicy(before, withField(before, "SMTP_HOST", (f) => ({ ...f, since: "0.2.0" })));
    expect(sinceBump).toHaveLength(0);
    expect(
      diffManifests(before, withField(before, "SMTP_HOST", (f) => ({ ...f, since: "0.2.0" }))).changed,
    ).toHaveLength(0);

    const deprecation = withField(before, "SMTP_HOST", (f) => ({ ...f, deprecatedSince: "0.1.0" }));
    const diff = diffManifests(before, deprecation);
    const change = diff.changed.find((c) => c.key === "SMTP_HOST");
    expect(change?.changedProps).toEqual(["deprecatedSince"]);
    expect(checkPolicy(before, deprecation)).toHaveLength(0);
  });
});

describe("parseEnvFile", () => {
  test("parses plain, quoted, and spaced values while skipping comments and malformed keys", () => {
    const parsed = parseEnvFile(
      [
        "# leading comment",
        "  # indented comment",
        "",
        "PLAIN=value",
        'QUOTED="double quoted"',
        "SINGLE='single quoted'",
        "SPACED = trimmed value  ",
        "NESTED=a=b",
        "EMPTY=",
        "1BAD=skip",
        "BAD-KEY=skip",
        "BAD KEY=skip",
        "=no-key",
        "NO_EQUALS_SIGN",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      PLAIN: "value",
      QUOTED: "double quoted",
      SINGLE: "single quoted",
      SPACED: "trimmed value",
      NESTED: "a=b",
      EMPTY: "",
    });
  });
});

describe("substituteTemplate", () => {
  const vars = { DOMAIN: "panel.example.com", EMPTY: "" };

  test("substitutes known variables", () => {
    expect(substituteTemplate("host ${DOMAIN}:3000", vars)).toBe("host panel.example.com:3000");
    expect(substituteTemplate("no vars here", vars)).toBe("no vars here");
  });

  test("falls back to defaults for missing variables", () => {
    expect(substituteTemplate("${MISSING:-fallback}", vars)).toBe("fallback");
    expect(substituteTemplate("${MISSING:-}", vars)).toBe("");
  });

  test("leaves unknown variables and $$-escaped references untouched", () => {
    expect(substituteTemplate("${MISSING}", vars)).toBe("${MISSING}");
    expect(substituteTemplate("$${LITERAL}", vars)).toBe("$${LITERAL}");
    expect(substituteTemplate("${9BAD}", vars)).toBe("${9BAD}");
  });

  test("substitutes empty-string values that are present", () => {
    expect(substituteTemplate("[${EMPTY}]", vars)).toBe("[]");
  });
});

describe("rendered output", () => {
  function writeOperatorYaml(path: string, domain: string, jwt: string): void {
    writeFileSync(
      path,
      [
        `domain: ${domain}`,
        "adminEmail: admin@example.com",
        "database:",
        "  user: tokenpanel",
        "  password: secret pass@word",
        "api:",
        `  jwtSecret: ${jwt}`,
        "",
      ].join("\n"),
    );
  }

  function render(dir: string, name: string, operatorPath: string) {
    const outDir = join(dir, name);
    return renderDeployment({
      operatorPath,
      templatesDir: TEMPLATES,
      outDir,
      dataDir: "/var/tokenpanel/shared",
      generatedConfigDir: outDir,
      managerVersion: "0.1.0",
    });
  }

  test("configHash is deterministic across runs", () => {
    withTempDir((dir) => {
      const operatorPath = join(dir, "tokenpanel.yml");
      writeOperatorYaml(operatorPath, "panel.example.com", SECRET);
      const a = render(dir, "a", operatorPath);
      const b = render(dir, "b", operatorPath);
      expect(a.configHash).toBe(b.configHash);
      expect(a.mode).toBe(b.mode);
      expect(a.files.map((f) => f.replace(/^.*\//, ""))).toEqual(
        b.files.map((f) => f.replace(/^.*\//, "")),
      );
      const release = JSON.parse(readFileSync(join(dir, "a", "release.json"), "utf8"));
      expect(release.configHash).toBe(a.configHash);
    });
  });

  test("configHash redacts secrets but reflects non-secret changes", () => {
    withTempDir((dir) => {
      const base = join(dir, "base.yml");
      writeOperatorYaml(base, "panel.example.com", SECRET);
      const a = render(dir, "a", base);

      const otherSecret = join(dir, "other-secret.yml");
      writeOperatorYaml(otherSecret, "panel.example.com", OTHER_SECRET);
      const b = render(dir, "b", otherSecret);
      expect(b.configHash).toBe(a.configHash);

      const otherDomain = join(dir, "other-domain.yml");
      writeOperatorYaml(otherDomain, "other.example.com", SECRET);
      const c = render(dir, "c", otherDomain);
      expect(c.configHash).not.toBe(a.configHash);

      const env = readFileSync(join(dir, "a", ".env"), "utf8");
      expect(env).toContain(`JWT_SECRET=${SECRET}`);
      const release = readFileSync(join(dir, "a", "release.json"), "utf8");
      expect(release).not.toContain(SECRET);
      expect(release).not.toContain("secret pass@word");
    });
  });
});

describe("manifest helpers", () => {
  const manifest = buildManifest("0.1.0");

  test("requiredKeys lists required non-derived fields only", () => {
    const required = requiredKeys(manifest);
    expect(required).toContain("DOMAIN");
    expect(required).toContain("ADMIN_EMAIL");
    expect(required).toContain("MONGO_USER");
    expect(required).toContain("MONGO_PASS");
    expect(required).toContain("JWT_SECRET");
    expect(required).not.toContain("MONGO_USER_URI");
    expect(required).not.toContain("MONGODB_URI");
    expect(required).not.toContain("USE_CADDY");
    expect(required).not.toContain("MONGODB_DB");
  });

  test("secretKeys lists every secret field and only secret fields", () => {
    const secrets = secretKeys(manifest);
    expect(secrets).toContain("MONGO_PASS");
    expect(secrets).toContain("MONGO_PASS_URI");
    expect(secrets).toContain("JWT_SECRET");
    expect(secrets).toContain("SMTP_PASS");
    expect(secrets).not.toContain("MONGO_USER");
    expect(secrets).not.toContain("JWT_SECRETX");
    for (const key of secrets) {
      expect(fieldByKey(key)?.secret).toBe(true);
    }
  });
  test("allowedKeys covers every config field in localeCompare order", () => {
    const allowed = allowedKeys(manifest);
    expect(allowed).toEqual([...allowed].sort((a, b) => a.localeCompare(b)));
    expect(allowed).toHaveLength(CONFIG_FIELDS.length);
    for (const field of CONFIG_FIELDS) {
      expect(allowed).toContain(field.key);
    }
  });

  test("allowedKeysTxt renders one key per line with trailing newline", () => {
    const txt = allowedKeysTxt(manifest);
    expect(txt.endsWith("\n")).toBe(true);
    expect(txt.split("\n")).toEqual([...allowedKeys(manifest), ""]);
  });

  test("formatEnvValue stringifies scalars and joins lists", () => {
    expect(formatEnvValue("raw")).toBe("raw");
    expect(formatEnvValue(3000)).toBe("3000");
    expect(formatEnvValue(true)).toBe("true");
    expect(formatEnvValue(false)).toBe("false");
    expect(formatEnvValue(["a", "b"])).toBe("a,b");
    expect(formatEnvValue([])).toBe("");
  });
});
