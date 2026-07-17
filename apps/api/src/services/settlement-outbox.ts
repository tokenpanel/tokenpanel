/**
 * Durable pending settlement when provider usage is missing or immediate
 * settlement cannot complete. Reconciliation workers drain this collection.
 * Policy constants: domains/settlement/policy.ts.
 *
 * Persistence: schema-decoding SettlementOutboxRepo only (task 14.2).
 * Primary API is Effect (run on ManagedRuntime / AppServices).
 */

import { ObjectId } from "mongodb";
import { createHash, randomBytes } from "node:crypto";
import { Effect } from "effect";
import type { SettlementOutboxDoc } from "@tokenpanel/db";
import {
  GATEWAY_REQUEST_ID_MAX,
  GATEWAY_REQUEST_ID_MAX_CHARS,
  OUTBOX_BACKOFF_BASE_SECONDS,
  OUTBOX_BACKOFF_CAP_SECONDS,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_CLAIM_TOKEN_BYTES,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_ATTEMPTS_COUNT,
  SETTLEMENT_REASON_MAX_CHARS,
} from "../domains/settlement/policy.ts";
import { SettlementOutboxRepo } from "../infrastructure/mongo/repositories/settlement-outbox.ts";
import type { MongoFailure } from "../infrastructure/mongo/try-mongo.ts";
import type { PersistenceDataError } from "../errors/index.ts";

export type SettlementOutboxStatus =
  | "pending"
  | "in_progress"
  | "reconciled"
  | "failed"
  | "abandoned";

export type OutboxIoError = MongoFailure | PersistenceDataError;

export {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_ATTEMPTS_COUNT,
  OUTBOX_CLAIM_LEASE_MS,
  GATEWAY_REQUEST_ID_MAX,
  GATEWAY_REQUEST_ID_MAX_CHARS,
};

export function nextOutboxAttemptAt(attempts: number, from = new Date()): Date {
  const exp = Math.min(
    OUTBOX_BACKOFF_CAP_SECONDS,
    OUTBOX_BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts),
  );
  return new Date(from.getTime() + exp * 1000);
}

/**
 * Fit an idempotency key into GATEWAY_REQUEST_ID_MAX without collisions.
 * Short keys pass through; long keys become a stable hash prefix so distinct
 * long provider IDs never truncate to the same key.
 */
export function compactGatewayRequestId(
  raw: string,
  maxLen = GATEWAY_REQUEST_ID_MAX,
): string {
  if (raw.length === 0) return raw;
  if (raw.length <= maxLen) return raw;
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  const prefix = "gwh_";
  return (prefix + hash).slice(0, maxLen);
}

/**
 * Stable idempotency key for outbox enqueue.
 * Prefer caller-provided id (one per HTTP/gateway request). Else derive from
 * provider request id so retries of the same upstream call collide on the
 * unique index. Never mint a fresh random id when providerRequestId is known.
 */
export function resolveGatewayRequestId(params: {
  gatewayRequestId?: string | undefined;
  providerRequestId?: string | undefined;
  organizationId: ObjectId;
}): string {
  if (params.gatewayRequestId && params.gatewayRequestId.length > 0) {
    return compactGatewayRequestId(params.gatewayRequestId);
  }
  if (params.providerRequestId && params.providerRequestId.length > 0) {
    const orgTail = params.organizationId.toHexString().slice(-8);
    const raw = `gw_${orgTail}_${params.providerRequestId}`;
    return compactGatewayRequestId(raw);
  }
  return newGatewayRequestId();
}

export type EnqueueOutboxParams = {
  organizationId: ObjectId;
  customerId: ObjectId | null;
  gatewayRequestId: string;
  reason: string;
  modelAliasId: string;
  providerId?: ObjectId | undefined;
  upstreamModelId?: string | undefined;
  protocol?: "openai" | "anthropic" | undefined;
  providerRequestId?: string | undefined;
  context?: Record<string, unknown> | undefined;
};

export const enqueueSettlementOutbox = (
  params: EnqueueOutboxParams,
): Effect.Effect<ObjectId, OutboxIoError, SettlementOutboxRepo> =>
  Effect.gen(function* () {
    const now = new Date();
    const _id = new ObjectId();
    const gatewayRequestId = compactGatewayRequestId(params.gatewayRequestId);
    const doc = {
      _id,
      organizationId: params.organizationId,
      customerId: params.customerId,
      gatewayRequestId,
      reason: params.reason.slice(0, SETTLEMENT_REASON_MAX_CHARS),
      modelAliasId: params.modelAliasId,
      providerId: params.providerId,
      upstreamModelId: params.upstreamModelId,
      protocol: params.protocol,
      providerRequestId: params.providerRequestId,
      context: params.context ?? {},
      status: "pending" as const,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    };
    const repo = yield* SettlementOutboxRepo;
    return yield* repo.insertOrGetByGatewayRequestId(doc as never);
  });

export function newGatewayRequestId(): string {
  return `gw_${new ObjectId().toHexString()}`;
}

export function newClaimToken(): string {
  return randomBytes(OUTBOX_CLAIM_TOKEN_BYTES).toString("hex");
}

/** Fencing credentials returned with each claim. */
export type OutboxClaim = {
  attempts: number;
  claimToken: string;
};

export const claimDueOutboxRows = (
  limit = 20,
): Effect.Effect<SettlementOutboxDoc[], OutboxIoError, SettlementOutboxRepo> =>
  Effect.gen(function* () {
    const repo = yield* SettlementOutboxRepo;
    const rows = yield* repo.claimDue(
      limit,
      OUTBOX_CLAIM_LEASE_MS,
      newClaimToken,
    );
    return [...rows] as SettlementOutboxDoc[];
  });

export const renewOutboxClaim = (
  id: ObjectId,
  claim: OutboxClaim,
): Effect.Effect<boolean, OutboxIoError, SettlementOutboxRepo> =>
  Effect.gen(function* () {
    const leaseUntil = new Date(Date.now() + OUTBOX_CLAIM_LEASE_MS);
    const repo = yield* SettlementOutboxRepo;
    return yield* repo.renewClaim(id, claim, leaseUntil);
  });

export const markOutboxReconciled = (
  id: ObjectId,
  claim: OutboxClaim,
): Effect.Effect<boolean, OutboxIoError, SettlementOutboxRepo> =>
  Effect.gen(function* () {
    const repo = yield* SettlementOutboxRepo;
    return yield* repo.markReconciled(id, claim);
  });

export const markOutboxFailed = (
  id: ObjectId,
  claim: OutboxClaim,
  error: string,
): Effect.Effect<boolean, OutboxIoError, SettlementOutboxRepo> =>
  Effect.gen(function* () {
    const repo = yield* SettlementOutboxRepo;
    return yield* repo.markFailed(id, claim, error);
  });

export const markOutboxAbandoned = (
  id: ObjectId,
  claim: OutboxClaim,
  reason: string,
): Effect.Effect<boolean, OutboxIoError, SettlementOutboxRepo> =>
  Effect.gen(function* () {
    const repo = yield* SettlementOutboxRepo;
    return yield* repo.markAbandoned(id, claim, reason);
  });

/**
 * After a failed recon attempt: abandon at max attempts, else return to
 * pending with backoff (releases in_progress claim). Fenced by claim token.
 */
export const releaseOutboxAfterFailure = (
  id: ObjectId,
  claim: OutboxClaim,
  error: string,
): Effect.Effect<boolean, OutboxIoError, SettlementOutboxRepo> =>
  Effect.gen(function* () {
    if (claim.attempts >= OUTBOX_MAX_ATTEMPTS) {
      return yield* markOutboxAbandoned(
        id,
        claim,
        `max_attempts: ${error.slice(0, 120)}`,
      );
    }
    const nextAttemptAt = nextOutboxAttemptAt(claim.attempts);
    const repo = yield* SettlementOutboxRepo;
    return yield* repo.releaseAfterFailure(id, claim, error, nextAttemptAt);
  });

/** Extract fencing credentials from a claimed row. */
export function claimFromRow(row: SettlementOutboxDoc): OutboxClaim | null {
  const token =
    typeof row.claimToken === "string" && row.claimToken.length > 0
      ? row.claimToken
      : null;
  if (!token) return null;
  return { attempts: row.attempts ?? 0, claimToken: token };
}
