/**
 * Effect-compatible runtime config decoding (task 3.1).
 *
 * `parseApiRuntimeConfig` remains the source of truth for validation semantics.
 * This module wraps it so boot / Layers can use the Effect error channel without
 * reimplementing JWT exact-bytes, production secret policy, Mongo URI, CORS,
 * canary org IDs, or operational defaults.
 */
import { Effect } from "effect";
import {
  parseApiRuntimeConfig,
  ConfigValidationError,
  type ApiRuntimeConfig,
} from "./runtime.ts";

/**
 * Decode env-like map into ApiRuntimeConfig on the Effect success channel.
 * Failures are always ConfigValidationError with aggregated safe issues
 * (never includes secret values).
 */
export function decodeApiRuntimeConfig(
  source: Readonly<Record<string, string | undefined>>,
): Effect.Effect<ApiRuntimeConfig, ConfigValidationError> {
  return Effect.try({
    try: () => parseApiRuntimeConfig(source),
    catch: (cause) => {
      if (cause instanceof ConfigValidationError) return cause;
      return new ConfigValidationError([
        {
          variable: "CONFIG",
          reason:
            cause instanceof Error
              ? cause.message
              : "unknown configuration failure",
        },
      ]);
    },
  });
}

/**
 * Sync helper for ManagedRuntime / tests that already own an Effect edge.
 * Prefer decodeApiRuntimeConfig in Effect programs.
 */
export function decodeApiRuntimeConfigSync(
  source: Readonly<Record<string, string | undefined>>,
): ApiRuntimeConfig {
  return parseApiRuntimeConfig(source);
}
