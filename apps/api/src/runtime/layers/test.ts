/**
 * Deterministic test Layers (task 3.4).
 */
import { Layer } from "effect";
import type { ApiRuntimeConfig } from "../../config/runtime.ts";
import { DEFAULT_OPERATIONAL_CONFIG } from "../../config/runtime.ts";
import { makeAppConfigLayer } from "./app-config.ts";
import { ClockTest, makeClockTest } from "./clock.ts";
import { CryptoTest } from "./crypto.ts";
import { makeLoggerTest, type CollectedLogLine } from "./logger.ts";
import { makeMongoTestLayer, MongoFailLayer } from "./mongo.ts";
import { ProviderRegistryTest } from "./provider-registry.ts";
import { TelemetryTest } from "./telemetry.ts";
import { makeWorkerControlTest } from "./worker-control.ts";
import { withRepositories, type AppServices } from "./live.ts";
import type { MongoDbService } from "../services/mongo-db.ts";
import type { MongoUnavailableError } from "./mongo.ts";

export {
  ClockTest,
  makeClockTest,
  CryptoTest,
  makeLoggerTest,
  makeMongoTestLayer,
  MongoFailLayer,
  makeWorkerControlTest,
  type CollectedLogLine,
};

/** Minimal valid config for unit tests (no real secrets required outside prod). */
export function makeTestConfig(
  over: Partial<ApiRuntimeConfig> & {
    database?: Partial<ApiRuntimeConfig["database"]>;
    operational?: Partial<ApiRuntimeConfig["operational"]>;
  } = {},
): ApiRuntimeConfig {
  const jwtSecret = over.jwtSecret ?? "test-secret-at-least-32-chars-long!!";
  return Object.freeze({
    environment: over.environment ?? "test",
    port: over.port ?? 3000,
    jwtSecret,
    corsOrigins: over.corsOrigins === undefined ? null : over.corsOrigins,
    database: Object.freeze({
      uri:
        over.database?.uri ??
        "mongodb://localhost:27017/?directConnection=true",
      name: over.database?.name ?? "tokenpanel_test",
    }),
    operational: Object.freeze({
      ...DEFAULT_OPERATIONAL_CONFIG,
      ...(over.operational ?? {}),
    }),
    trustProxy: over.trustProxy ?? false,
    trustedProxies: Object.freeze(
      over.trustedProxies ? [...over.trustedProxies] : [],
    ),
    trustCloudflare: over.trustCloudflare ?? false,
  });
}

export type TestLayerOptions = {
  readonly config?: ApiRuntimeConfig;
  readonly fixedMs?: number;
  readonly logLines?: CollectedLogLine[];
  readonly mongo?: Partial<MongoDbService>;
  readonly workerState?: { running: boolean };
  /** When true, Mongo Layer fails construction. */
  readonly mongoFail?: boolean;
};

/**
 * Full AppServices test graph without real Mongo sockets.
 * When mongoFail is true, Layer error is MongoUnavailableError.
 * Includes domain RepositoryLive when Mongo is present (section 10).
 */
export function makeAppTestLayer(
  opts: TestLayerOptions = {},
): Layer.Layer<AppServices, MongoUnavailableError | never> {
  const config = opts.config ?? makeTestConfig();
  const lines = opts.logLines ?? [];
  const clock =
    opts.fixedMs !== undefined ? makeClockTest(opts.fixedMs) : ClockTest;

  const core = Layer.mergeAll(
    makeAppConfigLayer(config),
    clock,
    CryptoTest,
    makeLoggerTest(lines),
    ProviderRegistryTest,
    TelemetryTest,
    makeWorkerControlTest(opts.workerState),
  );

  if (opts.mongoFail) {
    // Fail path does not provide repositories (construction fails on Mongo).
    return Layer.mergeAll(core, MongoFailLayer) as Layer.Layer<
      AppServices,
      MongoUnavailableError
    >;
  }
  const base = Layer.mergeAll(
    core,
    makeMongoTestLayer(opts.mongo),
  ) as Layer.Layer<import("./live.ts").CoreAppServices>;
  return withRepositories(base);
}
