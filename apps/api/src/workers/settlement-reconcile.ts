/**
 * Supervised Effect settlement reconcile worker (tasks 9.11 / 13.7 / 16.5).
 *
 * Production path: fiber forked inside ManagedRuntime via WorkerControl.start
 * (Effect.forkDaemon) — no process-global setInterval ownership.
 */

import { Duration, Effect, Fiber, Ref, Schedule } from "effect";
import type { ApiRuntimeConfig } from "../config/runtime.ts";
import { syncLog } from "../infrastructure/telemetry/sync-log.ts";
import { AppConfig } from "../runtime/services/app-config.ts";
import { Logger } from "../runtime/services/logger.ts";
import { processSettlementOutboxBatch } from "../services/settlement-reconcile.ts";
import type { WorkerControlService } from "../runtime/services/worker-control.ts";
import { getAppRuntime, isAppRuntimeInstalled } from "../runtime/app-runtime.ts";

export type ReconcileTickResult = {
  readonly claimed: number;
  readonly reconciled: number;
  readonly abandoned: number;
};

const EMPTY_TICK: ReconcileTickResult = {
  claimed: 0,
  reconciled: 0,
  abandoned: 0,
};

/**
 * One reconcile batch tick.
 * When ManagedRuntime is installed, runs the Effect batch on it (repos available).
 * Failures are observed and return empty so the schedule stays alive.
 */
export const reconcileTick = (
  batchSize: number,
): Effect.Effect<ReconcileTickResult> =>
  Effect.tryPromise({
    try: async () => {
      if (!isAppRuntimeInstalled()) {
        // Unit tests without runtime: treat as infrastructure miss.
        throw new Error("ManagedRuntime not installed");
      }
      return getAppRuntime().runPromise(
        processSettlementOutboxBatch(batchSize) as Effect.Effect<
          ReconcileTickResult,
          never,
          never
        >,
      );
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        syncLog("warn", "reconcile_iteration_failed", {
          error: e instanceof Error ? e.message : String(e),
        });
        return EMPTY_TICK;
      }),
    ),
  );

/**
 * Supervised loop: initial delay, then fixed-interval ticks.
 * `Schedule.spaced` serializes ticks (no overlap).
 */
export const settlementReconcileLoopWithLogger: Effect.Effect<
  void,
  never,
  AppConfig | Logger
> = Effect.gen(function* () {
  const config = yield* AppConfig;
  const logger = yield* Logger;
  const op = config.operational;
  const batchSize = op.settlementReconcileBatchSizeCount;
  const intervalMs = op.settlementReconcileIntervalMs;
  const initialDelayMs = op.settlementReconcileInitialDelayMs;

  if (initialDelayMs > 0) {
    yield* Effect.sleep(Duration.millis(initialDelayMs));
  }

  const schedule = Schedule.spaced(Duration.millis(intervalMs));

  yield* Effect.repeat(
    Effect.gen(function* () {
      const result = yield* reconcileTick(batchSize);
      if (result.claimed > 0) {
        yield* logger.info("settlement_reconcile_tick", {
          claimed: result.claimed,
          reconciled: result.reconciled,
          abandoned: result.abandoned,
        });
      }
    }),
    schedule,
  );
});

export const settlementReconcileLoop = settlementReconcileLoopWithLogger;

/** Interrupt-safe single batch for tests (no schedule). */
export const supervisedBatchOnce = (
  batchSize: number,
): Effect.Effect<ReconcileTickResult> => reconcileTick(batchSize);

/**
 * Overlap guard: skip tick when previous still running.
 */
export const withOverlapGuard = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  busy: Ref.Ref<boolean>,
): Effect.Effect<A | null, E, R> =>
  Effect.gen(function* () {
    const isBusy = yield* Ref.get(busy);
    if (isBusy) return null;
    yield* Ref.set(busy, true);
    return yield* effect.pipe(Effect.ensuring(Ref.set(busy, false)));
  });

/**
 * Build a WorkerControlService that owns the reconcile fiber.
 * AppConfig + Logger are closed over so the loop is R=never after provide.
 */
export function makeManagedRuntimeWorkerControl(params: {
  readonly config: Pick<ApiRuntimeConfig, "operational"> &
    Partial<ApiRuntimeConfig>;
}): WorkerControlService {
  const state: {
    fiber: Fiber.RuntimeFiber<void, never> | null;
  } = { fiber: null };

  const appConfigService = {
    environment: params.config.environment ?? ("production" as const),
    port: params.config.port ?? 0,
    jwtSecret: params.config.jwtSecret ?? "x".repeat(32),
    corsOrigins: params.config.corsOrigins ?? null,
    database: params.config.database ?? {
      uri: "mongodb://localhost",
      name: "tokenpanel",
    },
    operational: params.config.operational,
  };

  const loggerService = {
    debug: (message: string, fields?: Record<string, unknown>) =>
      Effect.sync(() => {
        if (fields) console.debug(`[reconcile] ${message}`, fields);
        else console.debug(`[reconcile] ${message}`);
      }),
    info: (message: string, fields?: Record<string, unknown>) =>
      Effect.sync(() => {
        if (fields) console.log(`[reconcile] ${message}`, fields);
        else console.log(`[reconcile] ${message}`);
      }),
    warn: (message: string, fields?: Record<string, unknown>) =>
      Effect.sync(() => {
        if (fields) console.warn(`[reconcile] ${message}`, fields);
        else console.warn(`[reconcile] ${message}`);
      }),
    error: (message: string, fields?: Record<string, unknown>) =>
      Effect.sync(() => {
        if (fields) console.error(`[reconcile] ${message}`, fields);
        else console.error(`[reconcile] ${message}`);
      }),
  };

  const loop: Effect.Effect<void, never, never> =
    settlementReconcileLoopWithLogger.pipe(
      Effect.provideService(AppConfig, appConfigService as never),
      Effect.provideService(Logger, loggerService as never),
      Effect.catchAllDefect(() => Effect.void),
    );

  return {
    start: () =>
      Effect.gen(function* () {
        if (state.fiber !== null) return;
        // forkDaemon: survives parent scope; interrupted on WorkerControl.stop.
        // Prefer runtime.fork when installed so AppServices (Mongo/repos) are
        // available to batch ticks via getAppRuntime().runPromise.
        if (isAppRuntimeInstalled()) {
          const fiber = getAppRuntime().runFork(loop);
          state.fiber = fiber as Fiber.RuntimeFiber<void, never>;
        } else {
          const fiber = yield* Effect.forkDaemon(loop);
          state.fiber = fiber;
        }
      }),
    stop: () =>
      Effect.gen(function* () {
        const fiber = state.fiber;
        if (!fiber) return;
        state.fiber = null;
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }),
    isRunning: () => state.fiber !== null,
  };
}
