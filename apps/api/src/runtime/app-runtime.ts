/**
 * Managed application runtime (task 3.5).
 *
 * One ManagedRuntime per process, built from a memoized Layer graph.
 * Handlers and workers reuse this instance — never rebuild Layers per request.
 */
import { Layer, ManagedRuntime } from "effect";
import type { AppServices } from "./layers/live.ts";
import { makeAppLiveLayer, makeAppLiveLayerWithMongo } from "./layers/live.ts";
import type { ApiRuntimeConfig } from "../config/runtime.ts";
import type { MongoDbService } from "./services/mongo-db.ts";
import type { MongoUnavailableError } from "./layers/mongo.ts";

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;
export type AppRuntimeWithMongoError = ManagedRuntime.ManagedRuntime<
  AppServices,
  MongoUnavailableError
>;

let current: AppRuntime | null = null;

/**
 * Create a ManagedRuntime from an arbitrary Layer that provides AppServices.
 * Does not install as the process singleton unless `install` is true.
 *
 * ManagedRuntime memoizes Layer construction internally for the instance life.
 */
export function createAppRuntime(
  layer: Layer.Layer<AppServices, never, never>,
  options?: { readonly install?: boolean },
): AppRuntime {
  const runtime = ManagedRuntime.make(layer);
  if (options?.install) {
    current = runtime;
  }
  return runtime;
}

/**
 * Production runtime with scoped Mongo Layer (connect on first use / runtime()).
 * Prefer bootApi which fail-fasts before readiness.
 */
export function createProductionRuntime(
  config: ApiRuntimeConfig,
  options?: { readonly install?: boolean },
): AppRuntimeWithMongoError {
  const layer = makeAppLiveLayer(config);
  const runtime = ManagedRuntime.make(layer);
  if (options?.install) {
    // After successful runtime() acquire, request path treats errors as defects.
    current = runtime as unknown as AppRuntime;
  }
  return runtime;
}

/**
 * Runtime from already-connected Mongo (dual-path with legacy index boot).
 */
export function createProductionRuntimeWithMongo(
  config: ApiRuntimeConfig,
  mongo: MongoDbService,
  options?: { readonly install?: boolean },
): AppRuntime {
  const layer = makeAppLiveLayerWithMongo(config, mongo);
  return createAppRuntime(layer, { install: options?.install ?? false });
}

/** Process singleton; throws if not installed. */
export function getAppRuntime(): AppRuntime {
  if (!current) {
    throw new Error(
      "App runtime not initialized. Call createAppRuntime(..., { install: true }) or bootApi() first.",
    );
  }
  return current;
}

export function isAppRuntimeInstalled(): boolean {
  return current !== null;
}

/**
 * Dispose the installed runtime (runs Layer finalizers, e.g. Mongo close).
 * Idempotent.
 */
export async function disposeAppRuntime(): Promise<void> {
  if (!current) return;
  const rt = current;
  current = null;
  await rt.dispose();
}

/** Test helper: clear singleton without dispose (when runtime already disposed). */
export function clearAppRuntimeSingleton(): void {
  current = null;
}
