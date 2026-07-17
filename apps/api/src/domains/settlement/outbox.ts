/**
 * Settlement outbox typed operations (task 9.10).
 * Claim / lease / renew / backoff / fence / reconcile / abandon.
 * Primary path is pure Effect over SettlementOutboxRepo.
 */

import { Effect } from "effect";
import type { ObjectId } from "mongodb";
import type { SettlementOutboxDoc } from "@tokenpanel/db";
import { SystemError } from "../../errors/families.ts";
import { Clock } from "../../runtime/services/clock.ts";
import type { SettlementOutboxRepo } from "../../infrastructure/mongo/repositories/settlement-outbox.ts";
import {
  claimDueOutboxRows,
  claimFromRow,
  compactGatewayRequestId,
  enqueueSettlementOutbox,
  markOutboxAbandoned,
  markOutboxFailed,
  markOutboxReconciled,
  nextOutboxAttemptAt,
  newClaimToken,
  newGatewayRequestId,
  releaseOutboxAfterFailure,
  renewOutboxClaim,
  resolveGatewayRequestId,
  type OutboxClaim,
  type SettlementOutboxStatus,
} from "../../services/settlement-outbox.ts";
import {
  OUTBOX_BACKOFF_BASE_SECONDS,
  OUTBOX_BACKOFF_CAP_SECONDS,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS_COUNT,
} from "./policy.ts";

export type { OutboxClaim, SettlementOutboxStatus };

export {
  compactGatewayRequestId,
  resolveGatewayRequestId,
  newGatewayRequestId,
  newClaimToken,
  claimFromRow,
  nextOutboxAttemptAt,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS_COUNT,
};

export type OutboxError = SystemError;

function mapOutbox(message: string) {
  return (e: unknown) =>
    new SystemError({
      code: "system_error",
      message,
      diagnostic: e instanceof Error ? e.message : String(e),
    });
}

/** Pure backoff nextAttemptAt using Clock (or explicit from). */
export const computeNextAttemptAt = (
  attempts: number,
): Effect.Effect<Date, never, Clock> =>
  Effect.gen(function* () {
    const clock = yield* Clock;
    return nextOutboxAttemptAt(attempts, clock.now());
  });

/** Pure: should this claim be abandoned at max attempts? */
export function shouldAbandon(attempts: number): boolean {
  return attempts >= OUTBOX_MAX_ATTEMPTS_COUNT;
}

/** Pure lease expiry. */
export function leaseUntil(fromMs: number): Date {
  return new Date(fromMs + OUTBOX_CLAIM_LEASE_MS);
}

/** Pure exponential backoff seconds. */
export function backoffSeconds(attempts: number): number {
  return Math.min(
    OUTBOX_BACKOFF_CAP_SECONDS,
    OUTBOX_BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts),
  );
}

/** Enqueue durable pending settlement (idempotent on gatewayRequestId). */
export const enqueueOutboxOp = (params: {
  readonly organizationId: ObjectId;
  readonly customerId: ObjectId | null;
  readonly gatewayRequestId: string;
  readonly reason: string;
  readonly modelAliasId: string;
  readonly providerId?: ObjectId | undefined;
  readonly upstreamModelId?: string | undefined;
  readonly protocol?: "openai" | "anthropic" | undefined;
  readonly providerRequestId?: string | undefined;
  readonly context?: Record<string, unknown> | undefined;
}): Effect.Effect<ObjectId, OutboxError, SettlementOutboxRepo> =>
  enqueueSettlementOutbox(params).pipe(
    Effect.mapError(mapOutbox("Outbox enqueue failed")),
  );

export const claimDueOp = (
  limit = 20,
): Effect.Effect<
  readonly SettlementOutboxDoc[],
  OutboxError,
  SettlementOutboxRepo
> =>
  claimDueOutboxRows(limit).pipe(
    Effect.mapError(mapOutbox("Outbox claim failed")),
  );

export const renewClaimOp = (
  id: ObjectId,
  claim: OutboxClaim,
): Effect.Effect<boolean, OutboxError, SettlementOutboxRepo> =>
  renewOutboxClaim(id, claim).pipe(
    Effect.mapError(mapOutbox("Outbox renew failed")),
  );

export const markReconciledOp = (
  id: ObjectId,
  claim: OutboxClaim,
): Effect.Effect<boolean, OutboxError, SettlementOutboxRepo> =>
  markOutboxReconciled(id, claim).pipe(
    Effect.mapError(mapOutbox("Outbox mark reconciled failed")),
  );

export const markFailedOp = (
  id: ObjectId,
  claim: OutboxClaim,
  error: string,
): Effect.Effect<boolean, OutboxError, SettlementOutboxRepo> =>
  markOutboxFailed(id, claim, error).pipe(
    Effect.mapError(mapOutbox("Outbox mark failed failed")),
  );

export const markAbandonedOp = (
  id: ObjectId,
  claim: OutboxClaim,
  reason: string,
): Effect.Effect<boolean, OutboxError, SettlementOutboxRepo> =>
  markOutboxAbandoned(id, claim, reason).pipe(
    Effect.mapError(mapOutbox("Outbox mark abandoned failed")),
  );

export const releaseAfterFailureOp = (
  id: ObjectId,
  claim: OutboxClaim,
  error: string,
): Effect.Effect<boolean, OutboxError, SettlementOutboxRepo> =>
  releaseOutboxAfterFailure(id, claim, error).pipe(
    Effect.mapError(mapOutbox("Outbox release after failure failed")),
  );
