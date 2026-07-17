import { Layer } from "effect";
import { Clock, type ClockService } from "../services/clock.ts";

export const ClockLive = Layer.succeed(Clock, {
  nowMs: () => Date.now(),
  now: () => new Date(),
} satisfies ClockService);

/** Fixed clock for deterministic tests. */
export function makeClockTest(fixedMs: number): Layer.Layer<Clock> {
  return Layer.succeed(Clock, {
    nowMs: () => fixedMs,
    now: () => new Date(fixedMs),
  } satisfies ClockService);
}

export const ClockTest = makeClockTest(1_700_000_000_000);
