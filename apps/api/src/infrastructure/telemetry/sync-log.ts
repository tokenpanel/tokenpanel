/**
 * Promise-path structured log sink (section 14.4).
 *
 * Owned console sink for non-Effect call sites (billing settle, reservation
 * reconcile batch). Prefer Effect `Logger` when inside Effects.
 * Boundary gate allowlists this file as a console owner.
 */
export type SyncLogLevel = "debug" | "info" | "warn" | "error";

export function syncLog(
  level: SyncLogLevel,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...(fields ?? {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
}
