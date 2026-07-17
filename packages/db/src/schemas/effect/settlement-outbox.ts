/**
 * Settlement outbox Effect schemas.
 */
import { Schema } from "effect";
import {
  ObjectIdFromSelf,
  DateFromSelf,
  TimestampFields,
  exactOptional,
  exactNullish,
  boundedString,
  maxString,
  NonNegativeSafeInt,
  UnknownRecord,
  UnknownRecordDefaultEmpty,
} from "./primitives.ts";

export const SettlementOutboxStatus = Schema.Literal(
  "pending",
  "in_progress",
  "reconciled",
  "failed",
  "abandoned",
);
export type SettlementOutboxStatus = Schema.Schema.Type<
  typeof SettlementOutboxStatus
>;

export const SettlementOutboxDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  customerId: exactNullish(ObjectIdFromSelf),
  gatewayRequestId: boundedString(1, 80),
  reason: boundedString(1, 200),
  modelAliasId: boundedString(1, 120),
  providerId: exactOptional(ObjectIdFromSelf),
  upstreamModelId: exactOptional(maxString(200)),
  protocol: exactOptional(Schema.Literal("openai", "anthropic")),
  providerRequestId: exactOptional(maxString(200)),
  context: UnknownRecordDefaultEmpty,
  status: Schema.optionalWith(SettlementOutboxStatus, {
    default: () => "pending" as const,
  }),
  attempts: Schema.optionalWith(NonNegativeSafeInt, { default: () => 0 }),
  claimToken: exactOptional(boundedString(1, 64)),
  nextAttemptAt: exactOptional(DateFromSelf),
  claimedAt: exactOptional(DateFromSelf),
  ...TimestampFields,
});

/** Insert boundary: full row before MongoDB write (domain fills ids/timestamps). */
export const SettlementOutboxCreateInput = Schema.Struct({
  _id: exactOptional(ObjectIdFromSelf),
  organizationId: ObjectIdFromSelf,
  customerId: exactNullish(ObjectIdFromSelf),
  gatewayRequestId: boundedString(1, 80),
  reason: boundedString(1, 200),
  modelAliasId: boundedString(1, 120),
  providerId: exactOptional(ObjectIdFromSelf),
  upstreamModelId: exactOptional(maxString(200)),
  protocol: exactOptional(Schema.Literal("openai", "anthropic")),
  providerRequestId: exactOptional(maxString(200)),
  context: exactOptional(UnknownRecord),
  status: exactOptional(SettlementOutboxStatus),
  attempts: exactOptional(NonNegativeSafeInt),
  claimToken: exactOptional(boundedString(1, 64)),
  nextAttemptAt: exactOptional(DateFromSelf),
  claimedAt: exactOptional(DateFromSelf),
});

/** Partial claim/complete/release updates (worker paths). */
export const SettlementOutboxUpdateInput = Schema.Struct({
  status: exactOptional(SettlementOutboxStatus),
  attempts: exactOptional(NonNegativeSafeInt),
  claimToken: exactOptional(boundedString(1, 64)),
  nextAttemptAt: exactOptional(DateFromSelf),
  claimedAt: exactOptional(DateFromSelf),
  context: exactOptional(UnknownRecord),
  reason: exactOptional(boundedString(1, 200)),
});

export type SettlementOutboxDoc = Schema.Schema.Type<
  typeof SettlementOutboxDoc
>;
export type SettlementOutboxCreateInput = Schema.Schema.Type<
  typeof SettlementOutboxCreateInput
>;
export type SettlementOutboxUpdateInput = Schema.Schema.Type<
  typeof SettlementOutboxUpdateInput
>;
