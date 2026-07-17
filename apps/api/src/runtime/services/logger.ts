/**
 * Structured logger port (task 3.3).
 */
import { Context, type Effect as Eff } from "effect";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export type LoggerService = {
  readonly debug: (message: string, fields?: LogFields) => Eff.Effect<void>;
  readonly info: (message: string, fields?: LogFields) => Eff.Effect<void>;
  readonly warn: (message: string, fields?: LogFields) => Eff.Effect<void>;
  readonly error: (message: string, fields?: LogFields) => Eff.Effect<void>;
};

export class Logger extends Context.Tag("tokenpanel/Logger")<
  Logger,
  LoggerService
>() {}
