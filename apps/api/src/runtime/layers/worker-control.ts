import { Effect, Layer } from "effect";
import type { ApiRuntimeConfig } from "../../config/runtime.ts";
import { makeManagedRuntimeWorkerControl } from "../../workers/settlement-reconcile.ts";
import {
  WorkerControl,
  type WorkerControlService,
} from "../services/worker-control.ts";

/**
 * Live worker control — ManagedRuntime-supervised reconcile fiber (13.7).
 * No process-global setInterval. WorkerControl.start forks via Effect.forkDaemon
 * under the application ManagedRuntime (index boot / bootApi shutdown).
 */
export function makeWorkerControlLive(
  config: ApiRuntimeConfig,
  _opts?: { readonly useEffectWorker?: boolean },
): Layer.Layer<WorkerControl> {
  // opts.useEffectWorker ignored — production always uses Effect fiber.
  const service = makeManagedRuntimeWorkerControl({ config });
  const wrapped: WorkerControlService = {
    start: () => service.start(),
    stop: () => service.stop(),
    isRunning: () => service.isRunning(),
  };
  return Layer.succeed(WorkerControl, wrapped);
}

/** No-op worker control for unit tests (no timers). */
export function makeWorkerControlTest(
  state?: { running: boolean },
): Layer.Layer<WorkerControl> {
  const s = state ?? { running: false };
  return Layer.succeed(WorkerControl, {
    start: () =>
      Effect.sync(() => {
        s.running = true;
      }),
    stop: () =>
      Effect.sync(() => {
        s.running = false;
      }),
    isRunning: () => s.running,
  });
}

export const WorkerControlTest = makeWorkerControlTest();
