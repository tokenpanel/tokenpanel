import { z } from "zod";
import {
  objectId,
  objectIdFromString,
  currencyCode,
  timestampFields,
  tokenCount,
  moneyMinor,
} from "./common.ts";
import { limitDimension } from "./limit.ts";

/**
 * Who/what produced this usage record. Distinguishes human-customer traffic
 * from server-to-server management calls so analytics can filter them, and so
 * an internal management call (no customer) is recorded as audit data without
 * debiting any balance.
 *
 * - `customer_key`: authenticated via a `tp_live_` customer API key.
 * - `management_key`: authenticated via a `tp_mgmt_` management API key. May
 *   attribute to a customer (customerId set) when the request carried a
 *   customerEmail, or be org-internal (customerId null, billed false).
 * - `playground`: an admin signed-in user using the in-panel playground.
 */
export const usageActorKind = z.enum(["customer_key", "management_key", "playground"]);
export type UsageActorKind = z.infer<typeof usageActorKind>;

/**
 * UsageRecord = one billable AI call made by a Customer through the proxy.
 * Append-only. Aggregated for rate-limit enforcement + analytics.
 *
 * customerId is null for org-internal management calls (actorKind
 * "management_key" without a resolved customerEmail) — those are recorded as
 * audit data without debiting any customer.
 */
export const usageRecordDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  /** Customer the usage is attributed to. Null for org-internal management calls. */
  customerId: objectId.nullish(),
  /** Customer API key id used (`tp_live_`). Null when actorKind is not customer_key. */
  apiKeyId: objectId.nullish(),
  /** Kind of caller. See usageActorKind. */
  actorKind: usageActorKind.default("customer_key"),
  /** Management key id when actorKind="management_key". */
  managementKeyId: objectId.nullish(),
  /** Snapshot of customerEmail used for attribution, when provided. */
  customerEmail: z.string().max(254).nullish(),
  /** The model alias the customer requested. */
  modelAliasId: z.string().min(1).max(80),
  /** The provider entry that actually served the call (failover target). */
  providerId: objectId,
  upstreamModelId: z.string().min(1).max(160),
  /** Request shape the customer used. */
  protocol: z.enum(["openai", "anthropic"]),
  /** Tokens consumed, split by role for prompt caching analysis. */
  promptTokens: tokenCount,
  completionTokens: tokenCount,
  reasoningTokens: tokenCount.default(0),
  cacheReadTokens: tokenCount.default(0),
  cacheWriteTokens: tokenCount.default(0),
  totalTokens: tokenCount,
  /** Cost charged to the org (minor units) — what we paid upstream. */
  costMinor: moneyMinor,
  /** Price charged to the customer (minor units) — what we billed. */
  priceMinor: moneyMinor,
  currency: currencyCode,
  /** Request id from the upstream provider for correlation. */
  providerRequestId: z.string().max(200).nullish(),
  /**
   * Gateway idempotency key (unique when set). Prevents double-charge when
   * recon retries after settle commits but before outbox mark-reconciled.
   */
  gatewayRequestId: z.string().min(1).max(80).nullish(),
  /** Whether the customer's balance was successfully debited. */
  billed: z.boolean().default(true),
  /** Error code from upstream, if the call failed. */
  errorCode: z.string().max(80).nullish(),
  /** HTTP status returned to the customer. */
  status: z.number().int().min(100).max(599),
  /** Latency in milliseconds. */
  durationMs: tokenCount.default(0),
  occurredAt: z.instanceof(Date),
  ...timestampFields,
});

export const usageRecordCreateInput = z.object({
  customerId: objectIdFromString.nullish(),
  apiKeyId: objectIdFromString.optional(),
  actorKind: usageActorKind.optional(),
  managementKeyId: objectIdFromString.optional(),
  customerEmail: z.string().max(254).nullish(),
  modelAliasId: z.string().min(1).max(80),
  providerId: objectIdFromString,
  upstreamModelId: z.string().min(1).max(160),
  protocol: z.enum(["openai", "anthropic"]),
  promptTokens: tokenCount,
  completionTokens: tokenCount,
  reasoningTokens: tokenCount.optional(),
  cacheReadTokens: tokenCount.optional(),
  cacheWriteTokens: tokenCount.optional(),
  costMinor: moneyMinor,
  priceMinor: moneyMinor,
  currency: currencyCode,
  providerRequestId: z.string().max(200).optional(),
  billed: z.boolean().optional(),
  errorCode: z.string().max(80).optional(),
  status: z.number().int().min(100).max(599),
  durationMs: tokenCount.optional(),
  occurredAt: z.coerce.date().optional(),
});

export type UsageRecordDoc = z.infer<typeof usageRecordDoc>;
export type UsageRecordCreateInput = z.infer<typeof usageRecordCreateInput>;

/**
 * RateLimitCounter = a rolling-window counter for enforcement.
 * One document per (customer, dimension, window, bucketStart).
 * Bucketed by time so we can sum across a window via aggregation.
 */
export const rateLimitCounterDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  customerId: objectId,
  dimension: limitDimension,
  /** Window length in seconds (matches the rule). */
  windowSeconds: z.number().int().positive(),
  /** Bucket start timestamp (floored to window). */
  bucketStart: z.instanceof(Date),
  /** Counted value in the dimension's unit. */
  count: tokenCount.default(0),
  /** Optional scope target (model alias / endpoint path). */
  scopeTarget: z.string().max(120).nullish(),
  ...timestampFields,
});

export const rateLimitCounterCreateInput = z.object({
  customerId: objectIdFromString,
  dimension: limitDimension,
  windowSeconds: z.number().int().positive(),
  bucketStart: z.coerce.date(),
  count: tokenCount.optional(),
  scopeTarget: z.string().max(120).nullish().optional(),
});

export type RateLimitCounterDoc = z.infer<typeof rateLimitCounterDoc>;
export type RateLimitCounterCreateInput = z.infer<
  typeof rateLimitCounterCreateInput
>;