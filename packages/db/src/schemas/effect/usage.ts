/**
 * Usage, actor, rate-counter Effect schemas.
 */
import { Schema } from "effect";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  DateFromSelf,
  DateFromUnknown,
  TimestampFields,
  CurrencyCode,
  TokenCount,
  MoneyUnits,
  HttpStatusCode,
  exactOptional,
  exactNullish,
  maxString,
  boundedString,
  ModelAliasId,
  PositiveSafeInt,
} from "./primitives.ts";
import { LimitDimension } from "./limit.ts";

export const UsageActorKind = Schema.Literal(
  "customer_key",
  "management_key",
  "playground",
);
export type UsageActorKind = Schema.Schema.Type<typeof UsageActorKind>;

export const Protocol = Schema.Literal("openai", "anthropic");

export const UsageRecordDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  customerId: exactNullish(ObjectIdFromSelf),
  apiKeyId: exactNullish(ObjectIdFromSelf),
  actorKind: Schema.optionalWith(UsageActorKind, {
    default: () => "customer_key" as const,
  }),
  managementKeyId: exactNullish(ObjectIdFromSelf),
  customerEmail: exactNullish(maxString(254)),
  modelAliasId: ModelAliasId,
  providerId: ObjectIdFromSelf,
  upstreamModelId: boundedString(1, 160),
  protocol: Protocol,
  promptTokens: TokenCount,
  completionTokens: TokenCount,
  reasoningTokens: Schema.optionalWith(TokenCount, { default: () => 0 }),
  cacheReadTokens: Schema.optionalWith(TokenCount, { default: () => 0 }),
  cacheWriteTokens: Schema.optionalWith(TokenCount, { default: () => 0 }),
  totalTokens: TokenCount,
  costUnits: MoneyUnits,
  priceUnits: MoneyUnits,
  currency: CurrencyCode,
  providerRequestId: exactNullish(maxString(200)),
  gatewayRequestId: exactNullish(boundedString(1, 80)),
  billed: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  errorCode: exactNullish(maxString(80)),
  status: HttpStatusCode,
  durationMs: Schema.optionalWith(TokenCount, { default: () => 0 }),
  occurredAt: DateFromSelf,
  ...TimestampFields,
});

export const UsageRecordCreateInput = Schema.Struct({
  customerId: exactNullish(ObjectIdFromString),
  apiKeyId: exactOptional(ObjectIdFromString),
  actorKind: exactOptional(UsageActorKind),
  managementKeyId: exactOptional(ObjectIdFromString),
  customerEmail: exactNullish(maxString(254)),
  modelAliasId: ModelAliasId,
  providerId: ObjectIdFromString,
  upstreamModelId: boundedString(1, 160),
  protocol: Protocol,
  promptTokens: TokenCount,
  completionTokens: TokenCount,
  reasoningTokens: exactOptional(TokenCount),
  cacheReadTokens: exactOptional(TokenCount),
  cacheWriteTokens: exactOptional(TokenCount),
  costUnits: MoneyUnits,
  priceUnits: MoneyUnits,
  currency: CurrencyCode,
  providerRequestId: exactOptional(maxString(200)),
  billed: exactOptional(Schema.Boolean),
  errorCode: exactOptional(maxString(80)),
  status: HttpStatusCode,
  durationMs: exactOptional(TokenCount),
  occurredAt: exactOptional(DateFromUnknown),
});

export type UsageRecordDoc = Schema.Schema.Type<typeof UsageRecordDoc>;
export type UsageRecordCreateInput = Schema.Schema.Type<
  typeof UsageRecordCreateInput
>;

export const RateLimitCounterDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  customerId: ObjectIdFromSelf,
  dimension: LimitDimension,
  windowSeconds: PositiveSafeInt,
  bucketStart: DateFromSelf,
  count: Schema.optionalWith(TokenCount, { default: () => 0 }),
  scopeTarget: exactNullish(maxString(120)),
  ...TimestampFields,
});

export const RateLimitCounterCreateInput = Schema.Struct({
  customerId: ObjectIdFromString,
  dimension: LimitDimension,
  windowSeconds: PositiveSafeInt,
  bucketStart: DateFromUnknown,
  count: exactOptional(TokenCount),
  scopeTarget: exactNullish(maxString(120)),
});

export type RateLimitCounterDoc = Schema.Schema.Type<
  typeof RateLimitCounterDoc
>;
export type RateLimitCounterCreateInput = Schema.Schema.Type<
  typeof RateLimitCounterCreateInput
>;

/** Aggregation projection: usage grouped by model alias (analytics). */
export const UsageByModelProjection = Schema.Struct({
  modelAliasId: ModelAliasId,
  requests: TokenCount,
  tokens: TokenCount,
  costUnits: MoneyUnits,
  priceUnits: MoneyUnits,
});

export type UsageByModelProjection = Schema.Schema.Type<
  typeof UsageByModelProjection
>;
