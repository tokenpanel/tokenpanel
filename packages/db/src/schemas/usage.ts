import { z } from "zod";
import {
  objectId,
  objectIdFromString,
  currencyCode,
  timestampFields,
} from "./common.ts";
import { limitDimension } from "./limit.ts";

/**
 * UsageRecord = one billable AI call made by a Customer through the proxy.
 * Append-only. Aggregated for rate-limit enforcement + analytics.
 */
export const usageRecordDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  customerId: objectId,
  /** Customer API key id used (for audit). */
  apiKeyId: objectId.nullish(),
  /** The model alias the customer requested. */
  modelAliasId: z.string().min(1).max(80),
  /** The provider entry that actually served the call (failover target). */
  providerId: objectId,
  upstreamModelId: z.string().min(1).max(160),
  /** Request shape the customer used. */
  protocol: z.enum(["openai", "anthropic"]),
  /** Tokens consumed, split by role for prompt caching analysis. */
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative(),
  /** Cost charged to the org (minor units) — what we paid upstream. */
  costMinor: z.number().int().nonnegative(),
  /** Price charged to the customer (minor units) — what we billed. */
  priceMinor: z.number().int().nonnegative(),
  currency: currencyCode,
  /** Request id from the upstream provider for correlation. */
  providerRequestId: z.string().max(200).nullish(),
  /** Whether the customer's balance was successfully debited. */
  billed: z.boolean().default(true),
  /** Error code from upstream, if the call failed. */
  errorCode: z.string().max(80).nullish(),
  /** HTTP status returned to the customer. */
  status: z.number().int().min(100).max(599),
  /** Latency in milliseconds. */
  durationMs: z.number().int().nonnegative().default(0),
  occurredAt: z.instanceof(Date),
  ...timestampFields,
});

export const usageRecordCreateInput = z.object({
  customerId: objectIdFromString,
  apiKeyId: objectIdFromString.optional(),
  modelAliasId: z.string().min(1).max(80),
  providerId: objectIdFromString,
  upstreamModelId: z.string().min(1).max(160),
  protocol: z.enum(["openai", "anthropic"]),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  costMinor: z.number().int().nonnegative(),
  priceMinor: z.number().int().nonnegative(),
  currency: currencyCode,
  providerRequestId: z.string().max(200).optional(),
  billed: z.boolean().optional(),
  errorCode: z.string().max(80).optional(),
  status: z.number().int().min(100).max(599),
  durationMs: z.number().int().nonnegative().optional(),
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
  count: z.number().int().nonnegative().default(0),
  /** Optional scope target (model alias / endpoint path). */
  scopeTarget: z.string().max(120).nullish(),
  ...timestampFields,
});

export const rateLimitCounterCreateInput = z.object({
  customerId: objectIdFromString,
  dimension: limitDimension,
  windowSeconds: z.number().int().positive(),
  bucketStart: z.coerce.date(),
  count: z.number().int().nonnegative().optional(),
  scopeTarget: z.string().max(120).nullish().optional(),
});

export type RateLimitCounterDoc = z.infer<typeof rateLimitCounterDoc>;
export type RateLimitCounterCreateInput = z.infer<
  typeof rateLimitCounterCreateInput
>;