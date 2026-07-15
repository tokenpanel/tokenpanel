import { ObjectId } from "mongodb";
import { createHash, randomBytes } from "node:crypto";
import { getDb, type SettlementOutboxDoc } from "@tokenpanel/db";
import { isDuplicateKeyError } from "../lib/crypto.ts";

/**
 * Durable pending settlement when provider usage is missing or immediate
 * settlement cannot complete. Reconciliation workers drain this collection.
 */

export type SettlementOutboxStatus =
  | "pending"
  | "in_progress"
  | "reconciled"
  | "failed"
  | "abandoned";

/** Max recon attempts before marking abandoned. */
export const OUTBOX_MAX_ATTEMPTS = 20;

/** Claim lease: stuck in_progress rows become reclaimable after this. */
export const OUTBOX_CLAIM_LEASE_MS = 5 * 60 * 1000;

/** Max stored length for gatewayRequestId (schema + unique index key). */
export const GATEWAY_REQUEST_ID_MAX = 80;

/** Base backoff seconds; doubles each attempt, capped. */
const BACKOFF_BASE_SEC = 5;
const BACKOFF_CAP_SEC = 3600;

export function nextOutboxAttemptAt(attempts: number, from = new Date()): Date {
  const exp = Math.min(
    BACKOFF_CAP_SEC,
    BACKOFF_BASE_SEC * 2 ** Math.max(0, attempts),
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
  // 64 hex chars from sha256; prefix keeps keys greppable.
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  const prefix = "gwh_";
  return (prefix + hash).slice(0, maxLen);
}

/**
 * Stable idempotency key for outbox enqueue.
 * Prefer caller-provided id (one per HTTP/gateway request). Else derive from
 * provider request id so retries of the same upstream call collide on the
 * unique index. Never mint a fresh random id when providerRequestId is known.
 * Long IDs are hashed (not truncated) so distinct requests stay unique.
 */
export function resolveGatewayRequestId(params: {
  gatewayRequestId?: string;
  providerRequestId?: string;
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

export async function enqueueSettlementOutbox(params: {
  organizationId: ObjectId;
  customerId: ObjectId | null;
  gatewayRequestId: string;
  reason: string;
  modelAliasId: string;
  providerId?: ObjectId;
  upstreamModelId?: string;
  protocol?: "openai" | "anthropic";
  providerRequestId?: string;
  context?: Record<string, unknown>;
}): Promise<ObjectId> {
  const db = await getDb();
  const now = new Date();
  const _id = new ObjectId();
  const gatewayRequestId = compactGatewayRequestId(params.gatewayRequestId);
  const doc = {
    _id,
    organizationId: params.organizationId,
    customerId: params.customerId,
    gatewayRequestId,
    reason: params.reason.slice(0, 200),
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
  try {
    await db.settlementOutbox.insertOne(doc);
    return _id;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const existing = await db.settlementOutbox.findOne({
        gatewayRequestId,
      });
      if (existing) return existing._id;
    }
    throw err;
  }
}

export function newGatewayRequestId(): string {
  return `gw_${new ObjectId().toHexString()}`;
}

export function newClaimToken(): string {
  return randomBytes(16).toString("hex");
}

/** Fencing credentials returned with each claim. */
export type OutboxClaim = {
  attempts: number;
  claimToken: string;
};

/**
 * Claim due rows: pending (or lease-expired in_progress) with nextAttemptAt <= now.
 * Sets status=in_progress, a claimToken fence, and a lease on nextAttemptAt so
 * overlapping workers cannot reclaim until the lease expires (or the worker finishes).
 */
export async function claimDueOutboxRows(
  limit = 20,
): Promise<SettlementOutboxDoc[]> {
  const db = await getDb();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS);
  const claimed: SettlementOutboxDoc[] = [];

  const candidates = await db.settlementOutbox
    .find({
      status: { $in: ["pending", "in_progress"] },
      $or: [
        { nextAttemptAt: { $lte: now } },
        { nextAttemptAt: { $exists: false } },
      ],
    })
    .sort({ nextAttemptAt: 1, createdAt: 1 })
    .limit(limit * 3)
    .toArray();

  for (const row of candidates) {
    if (claimed.length >= limit) break;
    // Only reclaim in_progress if lease (nextAttemptAt) already expired —
    // the find filter already enforces that; still require matching status.
    const nextAttempts = (row.attempts ?? 0) + 1;
    const claimToken = newClaimToken();
    // Atomic claim must re-check lease (nextAttemptAt): a concurrent owner may
    // renew between our candidate scan and this update. Matching only status +
    // attempts would let a worker steal a freshly renewed claim (TOCTOU).
    const res = await db.settlementOutbox.findOneAndUpdate(
      {
        _id: row._id,
        status: row.status,
        // Optimistic: attempts match snapshot (fencing against concurrent claim).
        attempts: row.attempts ?? 0,
        $or: [
          { nextAttemptAt: { $lte: now } },
          { nextAttemptAt: { $exists: false } },
        ],
      },
      {
        $set: {
          status: "in_progress",
          attempts: nextAttempts,
          claimToken,
          claimedAt: now,
          // Lease: do not reclaim until this time even if still in_progress.
          nextAttemptAt: leaseUntil,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    if (res) {
      claimed.push(res as SettlementOutboxDoc);
    }
  }
  return claimed;
}

function claimFilter(id: ObjectId, claim: OutboxClaim) {
  return {
    _id: id,
    status: "in_progress" as const,
    attempts: claim.attempts,
    claimToken: claim.claimToken,
  };
}

/**
 * Extend the claim lease so a long reconcile does not get reclaimed mid-flight.
 * Returns false if this worker no longer owns the claim.
 */
export async function renewOutboxClaim(
  id: ObjectId,
  claim: OutboxClaim,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS);
  const res = await db.settlementOutbox.updateOne(claimFilter(id, claim), {
    $set: { nextAttemptAt: leaseUntil, updatedAt: now },
  });
  return res.matchedCount === 1;
}

/**
 * Mark reconciled only if this worker still owns the claim.
 * Stale workers (expired lease reclaimed by another) cannot overwrite.
 */
export async function markOutboxReconciled(
  id: ObjectId,
  claim: OutboxClaim,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const res = await db.settlementOutbox.updateOne(claimFilter(id, claim), {
    $set: { status: "reconciled", updatedAt: now },
    $unset: { claimedAt: "", claimToken: "" },
  });
  return res.matchedCount === 1;
}

/**
 * Mark failed only if this worker still owns the claim.
 */
export async function markOutboxFailed(
  id: ObjectId,
  claim: OutboxClaim,
  error: string,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const row = await db.settlementOutbox.findOne(claimFilter(id, claim));
  if (!row) return false;
  const res = await db.settlementOutbox.updateOne(claimFilter(id, claim), {
    $set: {
      status: "failed",
      updatedAt: now,
      context: {
        ...(row.context ?? {}),
        lastError: error.slice(0, 500),
      },
    },
    $unset: { claimedAt: "", claimToken: "" },
  });
  return res.matchedCount === 1;
}

/**
 * Mark abandoned only if this worker still owns the claim.
 */
export async function markOutboxAbandoned(
  id: ObjectId,
  claim: OutboxClaim,
  reason: string,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const row = await db.settlementOutbox.findOne(claimFilter(id, claim));
  if (!row) return false;
  const res = await db.settlementOutbox.updateOne(claimFilter(id, claim), {
    $set: {
      status: "abandoned",
      updatedAt: now,
      context: {
        ...(row.context ?? {}),
        abandonReason: reason.slice(0, 200),
      },
    },
    $unset: { claimedAt: "", claimToken: "" },
  });
  return res.matchedCount === 1;
}

/**
 * After a failed recon attempt: abandon at max attempts, else return to
 * pending with backoff (releases in_progress claim). Fenced by claim token.
 */
export async function releaseOutboxAfterFailure(
  id: ObjectId,
  claim: OutboxClaim,
  error: string,
): Promise<boolean> {
  if (claim.attempts >= OUTBOX_MAX_ATTEMPTS) {
    return markOutboxAbandoned(id, claim, `max_attempts: ${error.slice(0, 120)}`);
  }
  const db = await getDb();
  const row = await db.settlementOutbox.findOne(claimFilter(id, claim));
  if (!row) return false;
  const now = new Date();
  const res = await db.settlementOutbox.updateOne(claimFilter(id, claim), {
    $set: {
      status: "pending",
      nextAttemptAt: nextOutboxAttemptAt(claim.attempts, now),
      updatedAt: now,
      context: {
        ...(row.context ?? {}),
        lastError: error.slice(0, 500),
      },
    },
    $unset: { claimedAt: "", claimToken: "" },
  });
  return res.matchedCount === 1;
}

/** Extract fencing credentials from a claimed row. */
export function claimFromRow(row: SettlementOutboxDoc): OutboxClaim | null {
  const token =
    typeof row.claimToken === "string" && row.claimToken.length > 0
      ? row.claimToken
      : null;
  if (!token) return null;
  return { attempts: row.attempts ?? 0, claimToken: token };
}
