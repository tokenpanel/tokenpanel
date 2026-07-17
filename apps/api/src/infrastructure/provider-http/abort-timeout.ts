/**
 * Merge an optional parent AbortSignal with an optional timeout.
 * Returns the signal to pass to fetch + a dispose() that clears the timer
 * and detaches listeners (call after headers arrive for streaming TTFB).
 */
export type MergedAbort = {
  readonly signal: AbortSignal | undefined;
  readonly dispose: () => void;
  /** True when the abort was caused by the timeout (not parent). */
  readonly timedOut: () => boolean;
};

export function mergeAbortTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): MergedAbort {
  const ms = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : 0;
  if (ms === 0 && !parent) {
    return {
      signal: undefined,
      dispose: () => undefined,
      timedOut: () => false,
    };
  }
  if (ms === 0 && parent) {
    return {
      signal: parent,
      dispose: () => undefined,
      timedOut: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = () => controller.abort();

  if (parent) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  return {
    signal: controller.signal,
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = undefined;
      if (parent) parent.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => timedOut,
  };
}
