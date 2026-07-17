/**
 * API-local query, date-range, status, pagination Effect schemas.
 * Used by route modules via sValidator / safeParseSchema.
 */
import { Schema } from "effect";
import {
  CoercedInt,
  PaginationLimit,
  PaginationSkip,
  Email,
  exactOptional,
  maxString,
  CurrencyCode,
  SafeInt,
} from "@tokenpanel/contracts/effect";

export const CustomerListQuery = Schema.Struct({
  limit: PaginationLimit,
  skip: PaginationSkip,
  status: exactOptional(
    Schema.Literal("active", "suspended", "closed"),
  ),
  q: exactOptional(maxString(160)),
});
export type CustomerListQuery = Schema.Schema.Type<typeof CustomerListQuery>;

export const HistoryQuery = Schema.Struct({
  limit: PaginationLimit,
  skip: PaginationSkip,
});
export type HistoryQuery = Schema.Schema.Type<typeof HistoryQuery>;

export const UsageDateRangeQuery = Schema.Struct({
  from: exactOptional(
    Schema.String.pipe(
      Schema.filter(
        (s): s is string => Number.isFinite(Date.parse(s)),
        { message: () => "Invalid datetime" },
      ),
    ),
  ),
  to: exactOptional(
    Schema.String.pipe(
      Schema.filter(
        (s): s is string => Number.isFinite(Date.parse(s)),
        { message: () => "Invalid datetime" },
      ),
    ),
  ),
});
export type UsageDateRangeQuery = Schema.Schema.Type<typeof UsageDateRangeQuery>;

export const AnalyticsSummaryQuery = Schema.Struct({
  from: Schema.String.pipe(Schema.minLength(1)),
  to: Schema.String.pipe(Schema.minLength(1)),
  top: Schema.optionalWith(
    CoercedInt.pipe(Schema.positive(), Schema.lessThanOrEqualTo(100)),
    { default: () => 20 },
  ),
});
export type AnalyticsSummaryQuery = Schema.Schema.Type<
  typeof AnalyticsSummaryQuery
>;

export const ApiKeyListQuery = Schema.Struct({
  customerId: exactOptional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  ),
});
export type ApiKeyListQuery = Schema.Schema.Type<typeof ApiKeyListQuery>;

export const ManagementKeyListQuery = Schema.Struct({
  status: exactOptional(Schema.Literal("active", "revoked")),
});
export type ManagementKeyListQuery = Schema.Schema.Type<
  typeof ManagementKeyListQuery
>;

export const EmailLookupQuery = Schema.Struct({
  email: Email,
});
export type EmailLookupQuery = Schema.Schema.Type<typeof EmailLookupQuery>;

// ---------------------------------------------------------------------------
// Local update/create wire bodies not owned by packages/db
// ---------------------------------------------------------------------------

export const BalanceAdjustBody = Schema.Struct({
  amountMinor: SafeInt,
  currency: CurrencyCode,
  reason: Schema.optionalWith(
    Schema.Literal("topup", "adjustment", "refund"),
    { default: () => "topup" as const },
  ),
  note: exactOptional(maxString(280)),
});
export type BalanceAdjustBody = Schema.Schema.Type<typeof BalanceAdjustBody>;

/** Management write may include usage_debit / overage as well. */
export const ManagementBalanceBody = Schema.Struct({
  amountMinor: SafeInt,
  currency: CurrencyCode,
  reason: Schema.optionalWith(
    Schema.Literal("topup", "usage_debit", "refund", "adjustment", "overage"),
    { default: () => "topup" as const },
  ),
  note: exactOptional(maxString(280)),
});
export type ManagementBalanceBody = Schema.Schema.Type<
  typeof ManagementBalanceBody
>;

export const SubscribeBody = Schema.Struct({
  planId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
});
export type SubscribeBody = Schema.Schema.Type<typeof SubscribeBody>;

export const CustomerStatusBody = Schema.Struct({
  status: Schema.Literal("active", "suspended", "closed"),
});
export type CustomerStatusBody = Schema.Schema.Type<typeof CustomerStatusBody>;

export const ApiKeyCreateBody = Schema.Struct({
  customerId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  modelWhitelist: exactOptional(
    Schema.Array(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
    ),
  ),
});
export type ApiKeyCreateBody = Schema.Schema.Type<typeof ApiKeyCreateBody>;
