import { Effect, Layer } from "effect";
import { Telemetry, type TelemetryService } from "../services/telemetry.ts";

const noop: TelemetryService = {
  flush: () => Effect.void,
  increment: () => Effect.void,
};

/** Production telemetry: no-op until structured observability (section 4). */
export const TelemetryLive = Layer.succeed(Telemetry, noop);

export const TelemetryTest = TelemetryLive;
