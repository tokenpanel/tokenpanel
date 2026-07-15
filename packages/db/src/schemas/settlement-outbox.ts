import { z } from "zod";
import { objectId, timestampFields } from "./common.ts";

/**
 * Durable pending settlement / reconciliation row.
 * Written when provider usage is missing or settleUsage fails after upstream success.
 */
export const settlementOutboxStatus = z.enum([
  "pending",
  /** Claimed by a worker; not reclaimable until nextAttemptAt (lease) expires. */
  "in_progress",
  "reconciled",
  "failed",
  "abandoned",
]);
export type SettlementOutboxStatus = z.infer<typeof settlementOutboxStatus>;

export const settlementOutboxDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  customerId: objectId.nullish(),
  /** Idempotency key for enqueue (unique index). */
  gatewayRequestId: z.string().min(1).max(80),
  reason: z.string().min(1).max(200),
  modelAliasId: z.string().min(1).max(120),
  providerId: objectId.optional(),
  upstreamModelId: z.string().max(200).optional(),
  protocol: z.enum(["openai", "anthropic"]).optional(),
  providerRequestId: z.string().max(200).optional(),
  /**
   * Bounded reconciliation snapshot (no prompts, raw keys, or secrets).
   * May include token counts, priceMinor, error message, actorKind.
   */
  context: z.record(z.unknown()).default(() => ({})),
  status: settlementOutboxStatus.default("pending"),
  attempts: z.number().int().nonnegative().default(0),
  /**
   * Opaque fencing token set on claim. Completion/release/abandon must match
   * so an expired worker cannot overwrite a newer claim or reconciled row.
   */
  claimToken: z.string().min(1).max(64).optional(),
  /**
   * When status is pending: earliest next claim time (backoff).
   * When status is in_progress: claim lease expiry (reclaim if stuck).
   */
  nextAttemptAt: z.instanceof(Date).optional(),
  claimedAt: z.instanceof(Date).optional(),
  ...timestampFields,
});

export type SettlementOutboxDoc = z.infer<typeof settlementOutboxDoc>;
