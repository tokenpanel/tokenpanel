/**
 * Application configuration service port (task 3.3).
 * Holds the validated ApiRuntimeConfig for the process lifetime.
 */
import { Context } from "effect";
import type { ApiRuntimeConfig } from "../../config/runtime.ts";

export class AppConfig extends Context.Tag("tokenpanel/AppConfig")<
  AppConfig,
  ApiRuntimeConfig
>() {}
