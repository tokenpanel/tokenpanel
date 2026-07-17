import { Layer } from "effect";
import type { ApiRuntimeConfig } from "../../config/runtime.ts";
import { AppConfig } from "../services/app-config.ts";

export function makeAppConfigLayer(
  config: ApiRuntimeConfig,
): Layer.Layer<AppConfig> {
  return Layer.succeed(AppConfig, config);
}
