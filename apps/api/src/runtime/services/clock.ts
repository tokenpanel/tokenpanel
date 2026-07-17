/**
 * Clock service port (task 3.3). Deterministic clocks in tests.
 */
import { Context } from "effect";

export type ClockService = {
  /** Epoch milliseconds. */
  readonly nowMs: () => number;
  /** Current wall clock as Date. */
  readonly now: () => Date;
};

export class Clock extends Context.Tag("tokenpanel/Clock")<
  Clock,
  ClockService
>() {}
