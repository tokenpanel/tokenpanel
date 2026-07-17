/**
 * Shared Effect Schema primitives for MongoDB documents.
 * Stored documents use real ObjectId + Date instances; input variants coerce.
 */
import { ObjectId } from "mongodb";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  DateFromSelf,
  TimestampFields,
  CurrencyCode,
  MoneyUnits,
  Money as MoneySchema,
  CustomerBalance as CustomerBalanceSchema,
  TokenCount,
  TokenPriceSchedule as TokenPriceScheduleSchema,
  TokenLimits as TokenLimitsSchema,
  Interleaved as InterleavedSchema,
  ModelCapabilities as ModelCapabilitiesSchema,
  ModelModality,
  ModelModalities,
  ModelStatus,
} from "./effect/primitives.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export type Money = MutableDeep<Schema.Schema.Type<typeof MoneySchema>>;
export type CustomerBalance = MutableDeep<
  Schema.Schema.Type<typeof CustomerBalanceSchema>
>;
export type TokenPriceSchedule = MutableDeep<
  Schema.Schema.Type<typeof TokenPriceScheduleSchema>
>;
export type TokenLimits = MutableDeep<Schema.Schema.Type<typeof TokenLimitsSchema>>;
export type Interleaved = MutableDeep<Schema.Schema.Type<typeof InterleavedSchema>>;
export type ModelCapabilities = MutableDeep<
  Schema.Schema.Type<typeof ModelCapabilitiesSchema>
>;
export type { ModelModalities, ModelStatus } from "@tokenpanel/contracts";

export const objectId = withParseApi(ObjectIdFromSelf);
export const objectIdFromString = withParseApi(ObjectIdFromString);
export const dateFromSelf = withParseApi(DateFromSelf);

/** Stored timestamps are Date instances. */
export const timestampFields = TimestampFields;

export const currencyCode = withParseApi(CurrencyCode);
export const moneyUnits = withParseApi(MoneyUnits);
export const tokenCount = withParseApi(TokenCount);
export const money = withParseApi(MoneySchema);
export const customerBalance = withParseApi(CustomerBalanceSchema);
export const tokenPriceSchedule = withParseApi(TokenPriceScheduleSchema);
export const tokenLimits = withParseApi(TokenLimitsSchema);
export const interleaved = withParseApi(InterleavedSchema);
export const modelCapabilities = withParseApi(ModelCapabilitiesSchema);

/** Product enums — Effect Schema (contracts constants remain source of truth). */
export const modalitySchema = withParseApi(ModelModality);
export const modalities = withParseApi(ModelModalities);
export const modelStatus = withParseApi(ModelStatus);

/** Re-export ObjectId constructor for callers that imported from common historically. */
export { ObjectId };
