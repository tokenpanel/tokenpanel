/**
 * Map infrastructure provider-http failures onto adapter ProviderError.
 * Keeps adapter error channel as ProviderError for fallback classification.
 */

import {
  isProviderAppError,
  type SystemError,
  type ProviderAppError,
} from "../errors/families.ts";
import type { ProviderHttpError } from "../infrastructure/provider-http/scoped-fetch.ts";
import { makeProviderError, type ProviderError } from "./provider-errors.ts";

export function httpFailureToProviderError(
  err: ProviderHttpError,
): ProviderError {
  if (isProviderAppError(err)) {
    return appErrorToProviderError(err);
  }
  return systemErrorToProviderError(err);
}

function appErrorToProviderError(err: ProviderAppError): ProviderError {
  return makeProviderError({
    message: err.message,
    category: err.category,
    phase: err.phase,
    ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    ...(err.providerRequestId !== undefined
      ? { providerRequestId: err.providerRequestId }
      : {}),
    retryable: err.retryClass === "transient",
    fallbackEligible: err.fallbackClass === "eligible",
    maybeAcceptedUpstream: err.acceptanceClass === "maybe_accepted",
    streamCommitted: err.streamCommitClass === "committed",
    ...(err.diagnostic !== undefined ? { diagnostic: err.diagnostic } : {}),
  });
}

function systemErrorToProviderError(err: SystemError): ProviderError {
  return makeProviderError({
    message: err.message,
    category: "unknown",
    phase: "request",
    ...(err.diagnostic !== undefined ? { diagnostic: err.diagnostic } : {}),
  });
}
