/**
 * Provider error classifier (task 4.4).
 * Maps ProviderError / fetch failures into canonical tagged provider errors.
 * Preserves isFallbackAllowed semantics from provider-errors.ts.
 */

import {
  isFallbackAllowed,
  ProviderError,
  publicProviderErrorMessage,
  type ProviderErrorCategory,
  type ProviderErrorPhase,
} from "../providers/provider-errors.ts";
import {
  ProviderProtocolError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  SystemError,
  type ProviderAppError,
} from "./families.ts";
import { SAFE_MESSAGES } from "./safe-messages.ts";
import {
  acceptanceClassOf,
  fallbackClassOf,
  PROTOCOL_CATEGORIES,
  REJECTED_CATEGORIES,
  retryClassOf,
  streamCommitClassOf,
  TIMEOUT_CATEGORIES,
  UNAVAILABLE_CATEGORIES,
} from "./variants.ts";

export type ClassifyProviderOptions = {
  readonly provider?: string;
  readonly model?: string;
  readonly operation?: string;
  readonly streamCommitted?: boolean;
  readonly label?: string;
};

function metaFromProviderError(
  err: ProviderError,
  opts: ClassifyProviderOptions,
) {
  const streamCommitted =
    opts.streamCommitted === true || err.streamCommitted === true;
  return {
    message: looksSafe(err.message)
      ? err.message
      : publicProviderErrorMessage(opts.label ?? "upstream", err.httpStatus),
    category: err.category,
    phase: err.phase,
    retryClass: retryClassOf(err.retryable),
    fallbackClass: fallbackClassOf(err.fallbackEligible && !streamCommitted),
    acceptanceClass: acceptanceClassOf(err.maybeAcceptedUpstream),
    streamCommitClass: streamCommitClassOf(streamCommitted),
    ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    ...(err.providerRequestId !== undefined
      ? { providerRequestId: err.providerRequestId }
      : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
    ...(err.diagnostic !== undefined ? { diagnostic: err.diagnostic } : {}),
  };
}

function looksSafe(msg: string): boolean {
  return msg.length <= 300 && !/api[_-]?key|password|secret|sk-/i.test(msg);
}

/**
 * Map a classified category to the correct tagged provider error constructor.
 */
export function providerErrorFromCategory(
  category: ProviderErrorCategory,
  fields: {
    message: string;
    phase: ProviderErrorPhase;
    retryable: boolean;
    fallbackEligible: boolean;
    maybeAcceptedUpstream: boolean;
    streamCommitted: boolean;
    httpStatus?: number;
    providerRequestId?: string;
    provider?: string;
    model?: string;
    operation?: string;
    diagnostic?: string;
  },
): ProviderAppError {
  const base = {
    message: fields.message,
    category,
    phase: fields.phase,
    retryClass: retryClassOf(fields.retryable),
    fallbackClass: fallbackClassOf(fields.fallbackEligible),
    acceptanceClass: acceptanceClassOf(fields.maybeAcceptedUpstream),
    streamCommitClass: streamCommitClassOf(fields.streamCommitted),
    ...(fields.httpStatus !== undefined ? { httpStatus: fields.httpStatus } : {}),
    ...(fields.providerRequestId !== undefined
      ? { providerRequestId: fields.providerRequestId }
      : {}),
    ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.operation !== undefined ? { operation: fields.operation } : {}),
    ...(fields.diagnostic !== undefined ? { diagnostic: fields.diagnostic } : {}),
  };

  if (TIMEOUT_CATEGORIES.has(category)) {
    return new ProviderTimeoutError({
      ...base,
      code: "provider_timeout",
    });
  }
  if (UNAVAILABLE_CATEGORIES.has(category)) {
    return new ProviderUnavailableError({
      ...base,
      code: "provider_unavailable",
    });
  }
  if (REJECTED_CATEGORIES.has(category)) {
    return new ProviderRejectedError({
      ...base,
      code: "provider_rejected",
    });
  }
  if (PROTOCOL_CATEGORIES.has(category)) {
    return new ProviderProtocolError({
      ...base,
      code: "provider_protocol",
    });
  }
  return new ProviderProtocolError({
    ...base,
    code: "provider_protocol",
  });
}

/**
 * Classify unknown provider-layer failures into tagged errors.
 * Unknown non-provider defects become SystemError.
 */
export function classifyProviderError(
  err: unknown,
  opts: ClassifyProviderOptions = {},
): ProviderAppError | SystemError {
  if (err instanceof ProviderError) {
    const meta = metaFromProviderError(err, opts);
    return providerErrorFromCategory(err.category, {
      message: meta.message,
      phase: meta.phase,
      retryable: meta.retryClass === "transient",
      fallbackEligible: meta.fallbackClass === "eligible",
      maybeAcceptedUpstream: meta.acceptanceClass === "maybe_accepted",
      streamCommitted: meta.streamCommitClass === "committed",
      ...(meta.httpStatus !== undefined ? { httpStatus: meta.httpStatus } : {}),
      ...(meta.providerRequestId !== undefined
        ? { providerRequestId: meta.providerRequestId }
        : {}),
      ...(meta.provider !== undefined ? { provider: meta.provider } : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.operation !== undefined ? { operation: meta.operation } : {}),
      ...(meta.diagnostic !== undefined ? { diagnostic: meta.diagnostic } : {}),
    });
  }

  // Pre-headers connect failures (TypeError / fetch failed) — same as isFallbackAllowed.
  if (err instanceof TypeError) {
    return new ProviderUnavailableError({
      code: "provider_unavailable",
      message: SAFE_MESSAGES.provider_unavailable,
      category: "connection",
      phase: "connect",
      retryClass: "transient",
      fallbackClass: opts.streamCommitted ? "ineligible" : "eligible",
      acceptanceClass: "not_accepted",
      streamCommitClass: streamCommitClassOf(opts.streamCommitted === true),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
      diagnostic: err.message.slice(0, 500),
    });
  }

  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err.message)) {
    return new ProviderUnavailableError({
      code: "provider_unavailable",
      message: SAFE_MESSAGES.provider_unavailable,
      category: "connection",
      phase: "connect",
      retryClass: "transient",
      fallbackClass: opts.streamCommitted ? "ineligible" : "eligible",
      acceptanceClass: "not_accepted",
      streamCommitClass: streamCommitClassOf(opts.streamCommitted === true),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.operation !== undefined ? { operation: opts.operation } : {}),
      diagnostic: err.message.slice(0, 500),
    });
  }

  if (err instanceof Error && /aborted|AbortError/i.test(err.name + err.message)) {
    return new ProviderRejectedError({
      code: "provider_rejected",
      message: SAFE_MESSAGES.provider_rejected,
      category: "abort",
      phase: "request",
      retryClass: "never",
      fallbackClass: "ineligible",
      acceptanceClass: "not_accepted",
      streamCommitClass: streamCommitClassOf(opts.streamCommitted === true),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      diagnostic: err.message.slice(0, 500),
    });
  }

  return new SystemError({
    code: "system_error",
    message: SAFE_MESSAGES.internal_server_error,
    diagnostic:
      err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
  });
}

/**
 * Fallback decision for either legacy ProviderError or tagged provider AppError.
 * Delegates to isFallbackAllowed for non-tagged values.
 */
export function isFallbackAllowedForError(
  err: unknown,
  streamCommitted: boolean,
): boolean {
  if (streamCommitted) return false;
  if (
    err instanceof ProviderRejectedError ||
    err instanceof ProviderUnavailableError ||
    err instanceof ProviderTimeoutError ||
    err instanceof ProviderProtocolError
  ) {
    if (err.streamCommitClass === "committed") return false;
    if (
      (err.phase === "body" || err.phase === "stream") &&
      err.fallbackClass === "ineligible"
    ) {
      return false;
    }
    if (
      err.acceptanceClass === "maybe_accepted" &&
      err.fallbackClass === "ineligible"
    ) {
      return false;
    }
    return err.fallbackClass === "eligible";
  }
  return isFallbackAllowed(err, streamCommitted);
}
