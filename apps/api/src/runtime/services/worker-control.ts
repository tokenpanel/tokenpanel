/**
 * Worker control port (task 3.3).
 * Start/stop background reconcile (and future supervised workers).
 */
import { Context, type Effect as Eff } from "effect";

export type WorkerControlService = {
  /** Start reconcile worker (idempotent). */
  readonly start: () => Eff.Effect<void>;
  /** Stop reconcile worker and cancel timers (idempotent). */
  readonly stop: () => Eff.Effect<void>;
  /** Whether the reconcile worker timer is currently registered. */
  readonly isRunning: () => boolean;
};

export class WorkerControl extends Context.Tag("tokenpanel/WorkerControl")<
  WorkerControl,
  WorkerControlService
>() {}
