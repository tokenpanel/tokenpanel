import { test, expect, describe } from "bun:test";
import {
  parseApiRuntimeConfig,
  ConfigValidationError,
} from "../runtime.ts";

const VALID_SECRET = "xK9mP2vQ7nR4sT8wY1zA5bC3dE6fG0hJ";
const VALID_URI = "mongodb://localhost:27017/?directConnection=true";

function base(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    JWT_SECRET: VALID_SECRET,
    MONGODB_URI: VALID_URI,
    MONGODB_DB: "tokenpanel",
    PORT: "3000",
    NODE_ENV: "development",
    ...over,
  };
}

describe("parseApiRuntimeConfig", () => {
  test("accepts minimal valid config", () => {
    const cfg = parseApiRuntimeConfig(base());
    expect(cfg.port).toBe(3000);
    expect(cfg.jwtSecret).toBe(VALID_SECRET);
    expect(cfg.database.uri).toBe(VALID_URI);
    expect(cfg.database.name).toBe("tokenpanel");
    expect(cfg.environment).toBe("development");
    expect(cfg.corsOrigins).toBeNull();
  });

  test("preserves exact JWT_SECRET bytes (no trim)", () => {
    const secret = ` ${"b".repeat(32)}`;
    // Leading space makes length 33; still exact.
    const cfg = parseApiRuntimeConfig(base({ JWT_SECRET: secret }));
    expect(cfg.jwtSecret).toBe(secret);
    expect(cfg.jwtSecret.startsWith(" ")).toBe(true);
  });

  test("defaults MONGODB_DB to tokenpanel when unset", () => {
    const cfg = parseApiRuntimeConfig(base({ MONGODB_DB: undefined }));
    expect(cfg.database.name).toBe("tokenpanel");
  });

  test("rejects missing JWT_SECRET without leaking value", () => {
    try {
      parseApiRuntimeConfig(base({ JWT_SECRET: undefined }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(err.message).not.toContain(VALID_SECRET);
      expect(err.issues.some((i) => i.variable === "JWT_SECRET")).toBe(true);
    }
  });

  test("allows short JWT_SECRET outside production (compat)", () => {
    const cfg = parseApiRuntimeConfig(
      base({ JWT_SECRET: "too-short", NODE_ENV: "development" }),
    );
    expect(cfg.jwtSecret).toBe("too-short");
  });

  test("rejects short JWT_SECRET in production", () => {
    expect(() =>
      parseApiRuntimeConfig(
        base({ JWT_SECRET: "too-short", NODE_ENV: "production" }),
      ),
    ).toThrow(ConfigValidationError);
  });

  test("rejects known sample JWT_SECRET variants in production", () => {
    for (const sample of [
      "change_me_to_a_long_random_string",
      "change_me_to_a_long_random_string_32chars",
      "change_me_anything_long_enough_here!!",
    ]) {
      expect(() =>
        parseApiRuntimeConfig(
          base({
            NODE_ENV: "production",
            JWT_SECRET: sample,
            CORS_ORIGINS: "https://admin.example.com",
          }),
        ),
      ).toThrow(/sample|default|weak|JWT_SECRET/i);
    }
  });

  test("rejects all-whitespace / identical-char JWT_SECRET in production", () => {
    expect(() =>
      parseApiRuntimeConfig(
        base({
          NODE_ENV: "production",
          JWT_SECRET: " ".repeat(32),
          CORS_ORIGINS: "https://admin.example.com",
        }),
      ),
    ).toThrow(ConfigValidationError);
    expect(() =>
      parseApiRuntimeConfig(
        base({
          NODE_ENV: "production",
          JWT_SECRET: "a".repeat(32),
          CORS_ORIGINS: "https://admin.example.com",
        }),
      ),
    ).toThrow(ConfigValidationError);
    // Repeated multi-unit Unicode must also be rejected (not only ASCII `.`).
    expect(() =>
      parseApiRuntimeConfig(
        base({
          NODE_ENV: "production",
          JWT_SECRET: "😀".repeat(16),
          CORS_ORIGINS: "https://admin.example.com",
        }),
      ),
    ).toThrow(ConfigValidationError);
  });

  test("allows sample JWT_SECRET outside production (dev)", () => {
    const sample = "change_me_to_a_long_random_string_32chars";
    const cfg = parseApiRuntimeConfig(
      base({ JWT_SECRET: sample, NODE_ENV: "development" }),
    );
    expect(cfg.jwtSecret).toBe(sample);
  });

  test("accepts strong random JWT_SECRET in production", () => {
    const strong = "xK9mP2vQ7nR4sT8wY1zA5bC3dE6fG0hJ";
    const cfg = parseApiRuntimeConfig(
      base({
        NODE_ENV: "production",
        JWT_SECRET: strong,
        CORS_ORIGINS: "https://admin.example.com",
      }),
    );
    expect(cfg.jwtSecret).toBe(strong);
  });

  test("rejects invalid Mongo protocol", () => {
    expect(() =>
      parseApiRuntimeConfig(base({ MONGODB_URI: "http://localhost" })),
    ).toThrow(/MONGODB_URI/);
  });

  test("port bounds: 1 and 65535 ok; 0, 65536, float, negative fail", () => {
    expect(parseApiRuntimeConfig(base({ PORT: "1" })).port).toBe(1);
    expect(parseApiRuntimeConfig(base({ PORT: "65535" })).port).toBe(65535);
    for (const bad of ["0", "65536", "3.14", "-1", "NaN", " 3000", "3000 "]) {
      expect(() => parseApiRuntimeConfig(base({ PORT: bad }))).toThrow(
        ConfigValidationError,
      );
    }
  });

  test("CORS: trims, dedupes, validates exact origins", () => {
    const cfg = parseApiRuntimeConfig(
      base({
        CORS_ORIGINS:
          " https://a.example.com , https://b.example.com, https://a.example.com ",
      }),
    );
    expect(cfg.corsOrigins).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  test("CORS: rejects path, query, credentials, non-http", () => {
    for (const bad of [
      "https://a.example.com/path",
      "https://a.example.com?x=1",
      "https://user:pass@a.example.com",
      "ftp://a.example.com",
      "not-a-url",
    ]) {
      expect(() =>
        parseApiRuntimeConfig(base({ CORS_ORIGINS: bad })),
      ).toThrow(ConfigValidationError);
    }
  });

  test("production without CORS_ORIGINS → empty allowlist (fail closed)", () => {
    const cfg = parseApiRuntimeConfig(
      base({ NODE_ENV: "production", CORS_ORIGINS: undefined }),
    );
    expect(cfg.corsOrigins).toEqual([]);
  });

  test("aggregates multiple validation failures", () => {
    try {
      parseApiRuntimeConfig({
        JWT_SECRET: undefined,
        MONGODB_URI: "bad",
        PORT: "0",
      });
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigValidationError;
      const vars = err.issues.map((i) => i.variable);
      expect(vars).toContain("JWT_SECRET");
      expect(vars).toContain("MONGODB_URI");
      expect(vars).toContain("PORT");
    }
  });

  test("trust proxy defaults off; parses TRUST_PROXY / TRUSTED_PROXIES / TRUST_CLOUDFLARE", () => {
    const off = parseApiRuntimeConfig(base());
    expect(off.trustProxy).toBe(false);
    expect(off.trustedProxies).toEqual([]);
    expect(off.trustCloudflare).toBe(false);

    const on = parseApiRuntimeConfig(
      base({
        TRUST_PROXY: "true",
        TRUSTED_PROXIES: "10.0.0.0/8, 172.18.0.2",
        TRUST_CLOUDFLARE: "1",
      }),
    );
    expect(on.trustProxy).toBe(true);
    expect(on.trustedProxies).toEqual(["10.0.0.0/8", "172.18.0.2"]);
    expect(on.trustCloudflare).toBe(true);
  });

  test("rejects invalid TRUST_PROXY boolean", () => {
    expect(() =>
      parseApiRuntimeConfig(base({ TRUST_PROXY: "maybe" })),
    ).toThrow(ConfigValidationError);
  });

  test("PROVIDER_HTTP_TIMEOUT_MS defaults to 120000; accepts 0 and custom", () => {
    const def = parseApiRuntimeConfig(base());
    expect(def.operational.providerHttpTimeoutMs).toBe(120_000);

    const off = parseApiRuntimeConfig(
      base({ PROVIDER_HTTP_TIMEOUT_MS: "0" }),
    );
    expect(off.operational.providerHttpTimeoutMs).toBe(0);

    const custom = parseApiRuntimeConfig(
      base({ PROVIDER_HTTP_TIMEOUT_MS: "300000" }),
    );
    expect(custom.operational.providerHttpTimeoutMs).toBe(300_000);
  });
});
