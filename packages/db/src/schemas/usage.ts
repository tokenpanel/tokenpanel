/**
 * Usage record + rate-limit counter schemas — Effect Schema (§11).
 */
import {
  UsageActorKind as UsageActorKindSchema,
  Protocol as ProtocolSchema,
  UsageRecordDoc as UsageRecordDocSchema,
  UsageRecordCreateInput as UsageRecordCreateInputSchema,
  RateLimitCounterDoc as RateLimitCounterDocSchema,
  RateLimitCounterCreateInput as RateLimitCounterCreateInputSchema,
  UsageByModelProjection as UsageByModelProjectionSchema,
} from "./effect/usage.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export const usageActorKind = withParseApi(UsageActorKindSchema);
export type UsageActorKind = Schema.Schema.Type<typeof UsageActorKindSchema>;

export const protocol = withParseApi(ProtocolSchema);
export const usageRecordDoc = withParseApi(UsageRecordDocSchema);
export const usageRecordCreateInput = withParseApi(UsageRecordCreateInputSchema);
export type UsageRecordDoc = MutableDeep<Schema.Schema.Type<typeof UsageRecordDocSchema>>;
export type UsageRecordCreateInput = MutableDeep<Schema.Schema.Type<typeof UsageRecordCreateInputSchema>>;

export const rateLimitCounterDoc = withParseApi(RateLimitCounterDocSchema);
export const rateLimitCounterCreateInput = withParseApi(RateLimitCounterCreateInputSchema);
export type RateLimitCounterDoc = MutableDeep<Schema.Schema.Type<typeof RateLimitCounterDocSchema>>;
export type RateLimitCounterCreateInput = MutableDeep<Schema.Schema.Type<typeof RateLimitCounterCreateInputSchema>>;

export const usageByModelProjection = withParseApi(UsageByModelProjectionSchema);
export type UsageByModelProjection = MutableDeep<Schema.Schema.Type<typeof UsageByModelProjectionSchema>>;
