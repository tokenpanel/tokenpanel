import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigResolutionError,
  buildManifest,
  checkPolicy,
  defaultsEnv,
  manifestEnv,
  migrateLegacyEnv,
  renderDeployment,
  resolveConfig,
  type ReleaseManifest,
} from "../index.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const TEMPLATES = join(ROOT, "manager", "templates");
const SECRET = "xK9mP2vQ7nR4sT8wY1zA5bC3dE6fG0hJ";

function operator() {
  return {
    domain: "panel.example.com",
    adminEmail: "admin@example.com",
    database: { user: "tokenpanel", password: "secret pass@word", name: "tokenpanel" },
    api: { jwtSecret: SECRET },
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tokenpanel-config-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("manifest", () => {
  test("builds deterministic required and allowed keys", () => {
    const manifest = buildManifest("0.1.0");
    expect(manifest.schema).toBe(1);
    expect(manifest.minManagerVersion).toBe("0.1.0");
    const required = manifest.fields.filter((f) => f.required && !f.derived).map((f) => f.key);
    expect(required).toContain("JWT_SECRET");
    expect(required).toContain("DOMAIN");
    expect(required).toContain("MONGO_USER");
    expect(required).toContain("MONGO_PASS");
  });

  test("manager fragments are bash-safe", () => {
    const manifest = buildManifest("0.1.0");
    const env = manifestEnv(manifest);
    expect(env).toContain("REQUIRED_KEYS=");
    expect(env).not.toContain(" ");
    const defaults = defaultsEnv(manifest);
    expect(defaults).toContain("USE_CADDY=y");
    expect(defaults).toContain("MONGODB_DB=tokenpanel");
    expect(defaults).not.toContain("\nJWT_SECRET=");
  });
});

describe("resolveConfig", () => {
  test("resolves operator config and derives URIs", () => {
    const resolved = resolveConfig({ operator: operator() });
    expect(resolved.mode).toBe("caddy");
    expect(resolved.env.USE_CADDY).toBe("y");
    expect(resolved.env.TRUST_PROXY).toBe("true");
    expect(resolved.env.MONGO_PASS_URI).toBe("secret%20pass%40word");
    expect(resolved.apiEnv.MONGODB_URI).toContain("mongo:27017/tokenpanel");
    expect(resolved.apiEnv.JWT_SECRET).toBe(SECRET);
    expect(resolved.composeVars.DOMAIN).toBe("panel.example.com");
  });

  test("direct mode defaults trustProxy false and publishes API_PORT", () => {
    const resolved = resolveConfig({
      operator: { ...operator(), proxy: { mode: "direct", apiPort: 8080 } },
    });
    expect(resolved.mode).toBe("direct");
    expect(resolved.env.USE_CADDY).toBe("n");
    expect(resolved.env.TRUST_PROXY).toBe("false");
    expect(resolved.env.API_PORT).toBe("8080");
  });

  test("legacy env fills missing operator values", () => {
    const legacy = migrateLegacyEnv({
      DOMAIN: "legacy.example.com",
      ADMIN_EMAIL: "legacy@example.com",
      MONGO_USER: "u",
      MONGO_PASS: "p",
      JWT_SECRET: SECRET,
      USE_CADDY: "n",
    });
    const resolved = resolveConfig({ operator: legacy });
    expect(resolved.mode).toBe("direct");
    expect(resolved.env.DOMAIN).toBe("legacy.example.com");
  });

  test("missing required fields throw aggregated issues", () => {
    try {
      resolveConfig({ operator: { domain: "x.example.com" } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigResolutionError);
      const err = e as ConfigResolutionError;
      const keys = err.issues.map((i) => i.key);
      expect(keys).toContain("JWT_SECRET");
      expect(keys).toContain("MONGO_USER");
    }
  });

  test("short JWT secret fails unless weak allowed", () => {
    const op = { ...operator(), api: { jwtSecret: "short" } };
    expect(() => resolveConfig({ operator: op })).toThrow(ConfigResolutionError);
    const ok = resolveConfig({
      operator: { ...op, api: { jwtSecret: "short", allowWeakJwtSecret: true } },
    });
    expect(ok.apiEnv.JWT_SECRET).toBe("short");
  });
});

describe("renderDeployment", () => {
  test("renders caddy deployment from operator yaml", () => {
    withTempDir((dir) => {
      const operatorPath = join(dir, "tokenpanel.yml");
      const outDir = join(dir, "generated");
      writeFileSync(
        operatorPath,
        [
          "domain: panel.example.com",
          "adminEmail: admin@example.com",
          "database:",
          "  user: tokenpanel",
          "  password: secret",
          "api:",
          `  jwtSecret: ${SECRET}`,
          "",
        ].join("\n"),
      );
      const result = renderDeployment({
        operatorPath,
        templatesDir: TEMPLATES,
        outDir,
        dataDir: "/var/tokenpanel/shared",
        generatedConfigDir: outDir,
        imageTag: "test-tag",
        managerVersion: "0.1.0",
      });
      expect(result.mode).toBe("caddy");
      const compose = readFileSync(join(outDir, "compose.yml"), "utf8");
      expect(compose.startsWith("name: tokenpanel\n")).toBe(true);
      expect(compose).toContain(`- ${outDir}/.env`);
      expect(compose).toContain("tokenpanel/app:current");
      expect(compose).toContain("$${MONGO_USER_URI}");
      expect(compose).not.toContain("${DOMAIN}");
      const env = readFileSync(join(outDir, ".env"), "utf8");
      expect(env).toContain(`JWT_SECRET=${SECRET}`);
      expect(env).toContain("MONGODB_URI=mongodb://tokenpanel:secret@mongo:27017/tokenpanel");
      expect(existsSync(join(outDir, "Caddyfile"))).toBe(true);
      const release = JSON.parse(readFileSync(join(outDir, "release.json"), "utf8"));
      expect(release.imageTag).toBe("test-tag");
      expect(release.managerVersion).toBe("0.1.0");
    });
  });

  test("migrates legacy env when operator yaml missing", () => {
    withTempDir((dir) => {
      const legacyPath = join(dir, ".env");
      const operatorPath = join(dir, "tokenpanel.yml");
      const outDir = join(dir, "generated");
      writeFileSync(
        legacyPath,
        [
          "DOMAIN=legacy.example.com",
          "ADMIN_EMAIL=admin@example.com",
          "MONGO_USER=tokenpanel",
          "MONGO_PASS=tokenpanel_dev",
          `JWT_SECRET=${SECRET}`,
          "USE_CADDY=n",
          "API_PORT=8080",
          "",
        ].join("\n"),
      );
      const result = renderDeployment({
        operatorPath,
        legacyEnvPath: legacyPath,
        templatesDir: TEMPLATES,
        outDir,
        dataDir: "/var/tokenpanel/shared",
        generatedConfigDir: outDir,
        managerVersion: "0.1.0",
      });
      expect(result.mode).toBe("direct");
      expect(existsSync(operatorPath)).toBe(true);
      const compose = readFileSync(join(outDir, "compose.yml"), "utf8");
      expect(compose).toContain('"8080:3000"');
      expect(existsSync(join(outDir, "Caddyfile"))).toBe(false);
    });
  });
});

describe("policy", () => {
  function baseline(): ReleaseManifest {
    return buildManifest("0.1.0");
  }

  test("passes unchanged manifest", () => {
    const issues = checkPolicy(baseline(), buildManifest("0.1.0"));
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("rejects removing an undePRECATED key", () => {
    const before = baseline();
    const after: ReleaseManifest = {
      ...before,
      fields: before.fields.filter((f) => f.key !== "SMTP_HOST"),
    };
    const issues = checkPolicy(before, after);
    expect(issues.some((i) => i.level === "error" && i.key === "SMTP_HOST")).toBe(true);
  });

  test("rejects new required key without default", () => {
    const before = baseline();
    const after: ReleaseManifest = {
      ...before,
      fields: [
        ...before.fields,
        {
          key: "NEW_REQUIRED",
          kind: "string",
          scope: "api",
          required: true,
          secret: false,
          derived: false,
        },
      ],
    };
    const issues = checkPolicy(before, after);
    expect(issues.some((i) => i.level === "error" && i.key === "NEW_REQUIRED")).toBe(true);
  });
});
