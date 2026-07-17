import type { ApiRuntimeConfig } from "./runtime.ts";

/**
 * Process-local API config set once at boot (or by tests).
 * Avoids scattering process.env reads across routes.
 */

let current: ApiRuntimeConfig | null = null;

export function setApiRuntimeConfig(config: ApiRuntimeConfig): void {
  current = config;
}

export function getApiRuntimeConfig(): ApiRuntimeConfig {
  if (!current) {
    throw new Error(
      "API runtime config not initialized. Call setApiRuntimeConfig at process boot.",
    );
  }
  return current;
}

/** Clear config (tests / shutdown). */
export function clearApiRuntimeConfig(): void {
  current = null;
}

export function isApiRuntimeConfigSet(): boolean {
  return current !== null;
}

/**
 * JWT secret for signing. Requires setApiRuntimeConfig at boot (task 14.1).
 * Never logs the value. No process.env fallback.
 */
export function requireJwtSecret(): string {
  if (current) return current.jwtSecret;
  throw new Error("JWT_SECRET not configured");
}
