/**
 * Fail-fast API boot + bounded graceful shutdown (tasks 3.7 / 3.8).
 *
 * Order: parse config → layers / ManagedRuntime → mongo connect+ping →
 * pre migrations → ready. SIGTERM/SIGINT register once for shutdown.
 *
 * Dual-path: `index.ts` may keep the historical process-global boot.
 * Call `bootApi()` from tests or from a future index cutover (section 10.9).
 */
import {
  configureDb,
  getDb,
  getClient,
  getRawDb,
  closeDb,
  runMigrations,
  isDbConfigured,
} from "@tokenpanel/db";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  parseApiRuntimeConfig,
  ConfigValidationError,
  type ApiRuntimeConfig,
} from "../config/runtime.ts";
import { decodeApiRuntimeConfig } from "../config/effect-decode.ts";
import { setApiRuntimeConfig, clearApiRuntimeConfig } from "../config/state.ts";
import { setJwtSecretForCrypto } from "../lib/crypto.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  getAppRuntime,
  isAppRuntimeInstalled,
  clearAppRuntimeSingleton,
  type AppRuntime,
} from "./app-runtime.ts";
import {
  makeAppLiveLayerWithMongo,
  makeAppTestLayer,
  type AppServices,
} from "./layers/index.ts";
import type { MongoDbService } from "./services/mongo-db.ts";
import { MongoDb } from "./services/mongo-db.ts";
import { WorkerControl } from "./services/worker-control.ts";
import { Telemetry } from "./services/telemetry.ts";
import { Logger } from "./services/logger.ts";
import { stopSettlementReconcileWorker } from "../services/settlement-reconcile.ts";

export type BootPhase =
  | "config"
  | "runtime"
  | "mongo"
  | "migrations"
  | "ready"
  | "shutdown";

export type BootResult = Readonly<{
  config: ApiRuntimeConfig;
  runtime: AppRuntime;
  mongo: MongoDbService;
  /** True after config+mongo+pre migrations succeed. */
  ready: true;
}>;

export type BootOptions = Readonly<{
  /** Env-like map; defaults to process.env at the executable boundary only. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * When provided, skip live Mongo connect and use this Layer graph
   * (unit tests). Must provide AppServices.
   */
  layer?: Layer.Layer<AppServices, never, never>;
  /** Run pre-deploy migrations (default true when using real Mongo). */
  runPreMigrations?: boolean;
  /** Install process singleton getAppRuntime() (default true). */
  installRuntime?: boolean;
  /** Register SIGTERM/SIGINT once (default false; index may own signals later). */
  registerSignals?: boolean;
  /** Apply transitional process globals (setApiRuntimeConfig, configureDb, jwt). Default true. */
  applyProcessGlobals?: boolean;
  /** Skip Mongo connect (requires test layer with Mongo stub). */
  skipMongo?: boolean;
}>;

export class BootError extends Error {
  readonly phase: BootPhase;
  readonly bootCause: unknown;

  constructor(phase: BootPhase, message: string, bootCause?: unknown) {
    super(message);
    this.name = "BootError";
    this.phase = phase;
    this.bootCause = bootCause;
  }
}

let signalsRegistered = false;
let shuttingDown = false;

function stubMongo(message: string): MongoDbService {
  const fail = (): never => {
    throw new Error(message);
  };
  return {
    get db() {
      return fail();
    },
    get client() {
      return fail();
    },
    get rawDb() {
      return fail();
    },
    close: async () => undefined,
  };
}

/**
 * Parse + validate config via Effect decode (same rules as parseApiRuntimeConfig).
 */
export async function bootParseConfig(
  env: Readonly<Record<string, string | undefined>>,
): Promise<ApiRuntimeConfig> {
  const exit = await Effect.runPromiseExit(decodeApiRuntimeConfig(env));
  if (Exit.isSuccess(exit)) return exit.value;
  for (const err of Cause.failures(exit.cause)) {
    if (err instanceof ConfigValidationError) throw err;
  }
  throw new BootError("config", "configuration decode failed", exit.cause);
}

/**
 * Full fail-fast boot. Does not start Bun.serve — caller owns HTTP listen.
 */
export async function bootApi(options: BootOptions = {}): Promise<BootResult> {
  const env = options.env ?? process.env;
  const installRuntime = options.installRuntime ?? true;
  const applyGlobals = options.applyProcessGlobals ?? true;
  const useCustomLayer = options.layer !== undefined;
  const skipMongo = options.skipMongo === true || useCustomLayer;
  const runPre =
    options.runPreMigrations ?? (!skipMongo && !useCustomLayer);

  let config: ApiRuntimeConfig;
  try {
    config = parseApiRuntimeConfig(env);
  } catch (err) {
    if (err instanceof ConfigValidationError) throw err;
    throw new BootError(
      "config",
      err instanceof Error ? err.message : "invalid configuration",
      err,
    );
  }

  if (applyGlobals) {
    setApiRuntimeConfig(config);
    setJwtSecretForCrypto(config.jwtSecret);
    if (!skipMongo && !isDbConfigured()) {
      configureDb({
        uri: config.database.uri,
        databaseName: config.database.name,
      });
    }
  }

  let mongo: MongoDbService;
  let runtime: AppRuntime;

  if (useCustomLayer && options.layer) {
    runtime = createAppRuntime(options.layer, { install: installRuntime });
    try {
      await runtime.runtime();
    } catch (err) {
      if (installRuntime) await disposeAppRuntime().catch(() => undefined);
      throw new BootError(
        "runtime",
        err instanceof Error ? err.message : "runtime layer failed",
        err,
      );
    }
    const mongoFromTag = await runtime.runPromiseExit(
      Effect.gen(function* () {
        return yield* MongoDb;
      }),
    );
    if (Exit.isSuccess(mongoFromTag)) {
      mongo = mongoFromTag.value;
    } else {
      mongo = stubMongo("Mongo not available in this boot path");
    }
  } else if (skipMongo) {
    const layer = makeAppTestLayer({ config }) as Layer.Layer<
      AppServices,
      never,
      never
    >;
    runtime = createAppRuntime(layer, { install: installRuntime });
    try {
      await runtime.runtime();
    } catch (err) {
      if (installRuntime) await disposeAppRuntime().catch(() => undefined);
      throw new BootError(
        "runtime",
        err instanceof Error ? err.message : "runtime layer failed",
        err,
      );
    }
    const mongoFromTag = await runtime.runPromiseExit(
      Effect.gen(function* () {
        return yield* MongoDb;
      }),
    );
    mongo = Exit.isSuccess(mongoFromTag)
      ? mongoFromTag.value
      : stubMongo("Mongo skipped");
  } else {
    try {
      if (!isDbConfigured()) {
        configureDb({
          uri: config.database.uri,
          databaseName: config.database.name,
        });
      }
      const db = await getDb();
      const client = getClient();
      const rawDb = getRawDb();
      await rawDb.command({ ping: 1 });
      mongo = {
        db,
        client,
        rawDb,
        close: () => closeDb(),
      };
    } catch (err) {
      throw new BootError(
        "mongo",
        err instanceof Error ? err.message : "MongoDB unavailable",
        err,
      );
    }

    if (runPre) {
      try {
        const preReport = await runMigrations(mongo.client, mongo.rawDb, "pre");
        if (preReport.applied.length > 0) {
          console.log(
            `migrations: ${preReport.applied.length} pre-deploy applied`,
          );
        }
      } catch (err) {
        await closeDb().catch(() => undefined);
        throw new BootError(
          "migrations",
          err instanceof Error ? err.message : "pre migration failed",
          err,
        );
      }
    }

    runtime = createAppRuntime(makeAppLiveLayerWithMongo(config, mongo), {
      install: installRuntime,
    });
    try {
      await runtime.runtime();
    } catch (err) {
      await closeDb().catch(() => undefined);
      if (installRuntime) await disposeAppRuntime().catch(() => undefined);
      throw new BootError(
        "runtime",
        err instanceof Error ? err.message : "runtime layer failed",
        err,
      );
    }
  }

  if (options.registerSignals) {
    registerShutdownSignals(config);
  }

  return { config, runtime, mongo, ready: true };
}

/**
 * Bounded graceful shutdown: stop workers → flush telemetry → dispose runtime
 * → close Mongo → clear process globals. Forces exit after timeout if requested.
 */
export async function shutdownApi(options?: {
  readonly config?: ApiRuntimeConfig;
  readonly exitProcess?: boolean;
  readonly exitCode?: number;
  readonly timeoutMs?: number;
}): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const timeoutMs =
    options?.timeoutMs ??
    options?.config?.operational.shutdownTimeoutMs ??
    10_000;
  const exitProcess = options?.exitProcess ?? false;
  const exitCode = options?.exitCode ?? 0;

  const work = (async () => {
    try {
      if (isAppRuntimeInstalled()) {
        const rt = getAppRuntime();
        await rt.runPromise(
          Effect.gen(function* () {
            const workers = yield* WorkerControl;
            yield* workers.stop();
            const telemetry = yield* Telemetry;
            yield* telemetry.flush();
            const log = yield* Logger;
            yield* log.info("shutdown: workers stopped, telemetry flushed");
          }),
        );
      }
    } catch {
      // Runtime may already be torn down
    }
    stopSettlementReconcileWorker();

    await disposeAppRuntime().catch(() => undefined);
    await closeDb().catch(() => undefined);
    clearApiRuntimeConfig();
    setJwtSecretForCrypto(null);
    clearAppRuntimeSingleton();
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      timer.unref();
    }
  });

  const winner = await Promise.race([
    work.then(() => "done" as const),
    timeout,
  ]);
  if (timer) clearTimeout(timer);

  if (winner === "timeout") {
    console.error(`shutdown: timed out after ${timeoutMs}ms; forcing exit`);
    if (exitProcess) {
      process.exit(exitCode === 0 ? 1 : exitCode);
    }
    shuttingDown = false;
    return;
  }

  if (exitProcess) {
    process.exit(exitCode);
  }
  shuttingDown = false;
}

/**
 * Register SIGTERM/SIGINT once. Subsequent calls are no-ops.
 */
export function registerShutdownSignals(config: ApiRuntimeConfig): void {
  if (signalsRegistered) return;
  signalsRegistered = true;
  const handler = () => {
    void shutdownApi({ config, exitProcess: true, exitCode: 0 });
  };
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}

/** Test helper: allow re-registering signals and re-running shutdown. */
export function resetShutdownStateForTests(): void {
  signalsRegistered = false;
  shuttingDown = false;
}
