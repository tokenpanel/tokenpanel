import { Effect, Layer, Ref } from "effect";
import {
  Logger,
  type LoggerService,
  type LogFields,
  type LogLevel,
} from "../services/logger.ts";

function writeJson(
  level: LogLevel,
  message: string,
  fields: LogFields | undefined,
): void {
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...(fields ?? {}),
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function makeConsoleLogger(): LoggerService {
  return {
    debug: (message, fields) =>
      Effect.sync(() => writeJson("debug", message, fields)),
    info: (message, fields) =>
      Effect.sync(() => writeJson("info", message, fields)),
    warn: (message, fields) =>
      Effect.sync(() => writeJson("warn", message, fields)),
    error: (message, fields) =>
      Effect.sync(() => writeJson("error", message, fields)),
  };
}

export const LoggerLive = Layer.succeed(Logger, makeConsoleLogger());

export type CollectedLogLine = Readonly<{
  level: LogLevel;
  message: string;
  fields?: LogFields;
}>;

/**
 * Test logger that collects lines into a Ref (or shared array when using the
 * factory below). Prefer makeLoggerTest for assertion access.
 */
export function makeLoggerTest(lines: CollectedLogLine[]): Layer.Layer<Logger> {
  const push = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (fields === undefined) {
      lines.push({ level, message });
    } else {
      lines.push({ level, message, fields });
    }
  };
  return Layer.succeed(Logger, {
    debug: (message, fields) => Effect.sync(() => push("debug", message, fields)),
    info: (message, fields) => Effect.sync(() => push("info", message, fields)),
    warn: (message, fields) => Effect.sync(() => push("warn", message, fields)),
    error: (message, fields) => Effect.sync(() => push("error", message, fields)),
  });
}

/** Empty collecting logger (lines discarded unless factory used). */
export const LoggerTest = makeLoggerTest([]);

/** Effect Ref-backed collector for concurrent test programs. */
export const makeLoggerTestLayer = (
  ref: Ref.Ref<readonly CollectedLogLine[]>,
): Layer.Layer<Logger> =>
  Layer.succeed(Logger, {
    debug: (message, fields) =>
      Ref.update(ref, (xs) => [
        ...xs,
        fields === undefined
          ? { level: "debug" as const, message }
          : { level: "debug" as const, message, fields },
      ]),
    info: (message, fields) =>
      Ref.update(ref, (xs) => [
        ...xs,
        fields === undefined
          ? { level: "info" as const, message }
          : { level: "info" as const, message, fields },
      ]),
    warn: (message, fields) =>
      Ref.update(ref, (xs) => [
        ...xs,
        fields === undefined
          ? { level: "warn" as const, message }
          : { level: "warn" as const, message, fields },
      ]),
    error: (message, fields) =>
      Ref.update(ref, (xs) => [
        ...xs,
        fields === undefined
          ? { level: "error" as const, message }
          : { level: "error" as const, message, fields },
      ]),
  });
