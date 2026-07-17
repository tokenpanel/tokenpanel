/**
 * Closed usage extraction outcomes (task 9.8).
 * reported | missing | malformed | overflow — never free-bill non-reported.
 */

import {
  parseAnthropicProviderUsage,
  parseOpenAIProviderUsage,
  type ProviderUsage,
  type TokenUsage,
} from "../../providers/provider-usage.ts";

export type UsageOutcome =
  | { readonly status: "reported"; readonly usage: TokenUsage }
  | {
      readonly status: "missing";
      readonly reason: string;
      readonly providerRequestId?: string | undefined;
    }
  | {
      readonly status: "malformed";
      readonly reason: string;
      readonly providerRequestId?: string | undefined;
    }
  | {
      readonly status: "overflow";
      readonly reason: string;
      readonly providerRequestId?: string | undefined;
    };

const MALFORMED_REASONS = new Set([
  "usage_malformed",
  "usage_inconsistent_total",
]);

const OVERFLOW_REASONS = new Set(["usage_overflow"]);

/**
 * Map legacy ProviderUsage (reported | missing) into closed UsageOutcome.
 * Reasons that historically used status=missing are reclassified.
 */
export function toUsageOutcome(u: ProviderUsage): UsageOutcome {
  if (u.status === "reported") {
    return { status: "reported", usage: u.usage };
  }
  if (OVERFLOW_REASONS.has(u.reason)) {
    return {
      status: "overflow",
      reason: u.reason,
      ...(u.providerRequestId !== undefined
        ? { providerRequestId: u.providerRequestId }
        : {}),
    };
  }
  if (MALFORMED_REASONS.has(u.reason)) {
    return {
      status: "malformed",
      reason: u.reason,
      ...(u.providerRequestId !== undefined
        ? { providerRequestId: u.providerRequestId }
        : {}),
    };
  }
  return {
    status: "missing",
    reason: u.reason,
    ...(u.providerRequestId !== undefined
      ? { providerRequestId: u.providerRequestId }
      : {}),
  };
}

/** OpenAI raw usage object → closed outcome. */
export function extractOpenAIUsage(u: unknown): UsageOutcome {
  return toUsageOutcome(parseOpenAIProviderUsage(u));
}

/** Anthropic raw usage object → closed outcome. */
export function extractAnthropicUsage(u: unknown): UsageOutcome {
  return toUsageOutcome(parseAnthropicProviderUsage(u));
}

/**
 * Whether this outcome may settle immediately (only reported).
 * missing/malformed/overflow → durable outbox, never free zero.
 */
export function isSettleableUsage(
  o: UsageOutcome,
): o is { status: "reported"; usage: TokenUsage } {
  return o.status === "reported";
}

/** Convert closed outcome back to ProviderUsage for settleUsageOrOutbox dual-path. */
export function toProviderUsage(o: UsageOutcome): ProviderUsage {
  if (o.status === "reported") {
    return { status: "reported", usage: o.usage };
  }
  return {
    status: "missing",
    reason: o.reason,
    ...(o.providerRequestId !== undefined
      ? { providerRequestId: o.providerRequestId }
      : {}),
  };
}

/**
 * From ChatResponse fields used by adapters (usageStatus + reason).
 */
export function usageFromChatResponse(params: {
  readonly usageStatus?: "reported" | "missing" | undefined;
  readonly usage: TokenUsage;
  readonly usageMissingReason?: string | undefined;
  readonly providerRequestId?: string | undefined;
}): UsageOutcome {
  if (params.usageStatus === "reported") {
    return { status: "reported", usage: params.usage };
  }
  const reason =
    params.usageMissingReason ??
    (params.usageStatus === "missing"
      ? "usage_missing"
      : "usage_status_unspecified");
  return toUsageOutcome({
    status: "missing",
    reason,
    providerRequestId: params.providerRequestId,
  });
}
