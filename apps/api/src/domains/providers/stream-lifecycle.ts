/**
 * Canonical streaming lifecycle state model (task 9.6).
 *
 * States:
 * - pre_commit: no client-visible delta/done yet (failover still possible)
 * - committed: first delta/done emitted (no fallback)
 * - terminal: successful stream completion with protocol terminal
 * - interrupted: client/runtime abort after or before commit
 * - provider_failed: upstream failure (phase-aware)
 * - usage_missing: completed stream without authoritative usage
 * - settlement_failed: charge path failed; durable outbox required
 */

export type StreamLifecycleState =
  | { readonly tag: "pre_commit" }
  | { readonly tag: "committed"; readonly entryId: string }
  | {
      readonly tag: "terminal";
      readonly entryId: string;
      readonly streamComplete: boolean;
    }
  | {
      readonly tag: "interrupted";
      readonly streamCommitted: boolean;
      readonly entryId?: string;
    }
  | {
      readonly tag: "provider_failed";
      readonly streamCommitted: boolean;
      readonly entryId?: string;
      readonly maybeAccepted: boolean;
      readonly reason: string;
    }
  | {
      readonly tag: "usage_missing";
      readonly entryId: string;
      readonly reason: string;
    }
  | {
      readonly tag: "settlement_failed";
      readonly entryId: string;
      readonly reason: string;
    };

export type StreamLifecycleEvent =
  | { readonly type: "delta"; readonly entryId: string }
  | { readonly type: "done"; readonly entryId: string; readonly streamComplete: boolean }
  | { readonly type: "interrupt" }
  | {
      readonly type: "provider_error";
      readonly reason: string;
      readonly maybeAccepted?: boolean;
    }
  | { readonly type: "usage_missing"; readonly reason: string }
  | { readonly type: "settlement_failed"; readonly reason: string }
  | { readonly type: "duplicate_terminal" };

export const initialStreamState = (): StreamLifecycleState => ({
  tag: "pre_commit",
});

/**
 * Pure state transition. Invalid transitions leave state unchanged and
 * return `rejected: true` (callers treat as no-op or protocol error).
 */
export function transitionStream(
  state: StreamLifecycleState,
  event: StreamLifecycleEvent,
): { readonly state: StreamLifecycleState; readonly rejected: boolean } {
  // Terminal-ish states ignore most further events (duplicate terminal safe).
  if (
    state.tag === "terminal" ||
    state.tag === "interrupted" ||
    state.tag === "provider_failed" ||
    state.tag === "usage_missing" ||
    state.tag === "settlement_failed"
  ) {
    if (event.type === "duplicate_terminal" || event.type === "done") {
      return { state, rejected: false };
    }
    if (event.type === "delta") {
      // Late delta after terminal — reject (do not reopen).
      return { state, rejected: true };
    }
    return { state, rejected: true };
  }

  switch (event.type) {
    case "delta": {
      if (state.tag === "pre_commit") {
        return {
          state: { tag: "committed", entryId: event.entryId },
          rejected: false,
        };
      }
      // already committed
      return { state, rejected: false };
    }
    case "done": {
      const entryId =
        state.tag === "committed" ? state.entryId : event.entryId;
      return {
        state: {
          tag: "terminal",
          entryId,
          streamComplete: event.streamComplete,
        },
        rejected: false,
      };
    }
    case "interrupt": {
      return {
        state: {
          tag: "interrupted",
          streamCommitted: state.tag === "committed",
          ...(state.tag === "committed" ? { entryId: state.entryId } : {}),
        },
        rejected: false,
      };
    }
    case "provider_error": {
      return {
        state: {
          tag: "provider_failed",
          streamCommitted: state.tag === "committed",
          ...(state.tag === "committed" ? { entryId: state.entryId } : {}),
          maybeAccepted: event.maybeAccepted === true,
          reason: event.reason,
        },
        rejected: false,
      };
    }
    case "usage_missing": {
      if (state.tag !== "committed" && state.tag !== "pre_commit") {
        return { state, rejected: true };
      }
      const entryId = state.tag === "committed" ? state.entryId : "unknown";
      return {
        state: {
          tag: "usage_missing",
          entryId,
          reason: event.reason,
        },
        rejected: false,
      };
    }
    case "settlement_failed": {
      const entryId = state.tag === "committed" ? state.entryId : "unknown";
      return {
        state: {
          tag: "settlement_failed",
          entryId,
          reason: event.reason,
        },
        rejected: false,
      };
    }
    case "duplicate_terminal":
      return { state, rejected: false };
  }
}

/** Whether fallback to next entry is still allowed. */
export function allowsFallback(state: StreamLifecycleState): boolean {
  return state.tag === "pre_commit";
}

/** Whether settlement / outbox should run (committed work may need charge). */
export function requiresSettlementConsideration(
  state: StreamLifecycleState,
): boolean {
  switch (state.tag) {
    case "pre_commit":
      return false;
    case "committed":
    case "terminal":
    case "interrupted":
    case "provider_failed":
    case "usage_missing":
    case "settlement_failed":
      return (
        state.tag === "committed" ||
        state.tag === "terminal" ||
        (state.tag === "interrupted" && state.streamCommitted) ||
        (state.tag === "provider_failed" &&
          (state.streamCommitted || state.maybeAccepted)) ||
        state.tag === "usage_missing" ||
        state.tag === "settlement_failed"
      );
  }
}
