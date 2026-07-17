/**
 * Telemetry port (task 3.3). Minimal interface; live is no-op until section 4.
 */
import { Context, type Effect as Eff } from "effect";

export type TelemetryService = {
  /** Flush buffered spans/metrics within shutdown bounds. */
  readonly flush: () => Eff.Effect<void>;
  /** Record a named counter increment (no-op live ok). */
  readonly increment: (
    name: string,
    value?: number,
    tags?: Readonly<Record<string, string>>,
  ) => Eff.Effect<void>;
};

export class Telemetry extends Context.Tag("tokenpanel/Telemetry")<
  Telemetry,
  TelemetryService
>() {}
