/**
 * Customer + balance-adjustment Effect schemas.
 */
import { Schema } from "effect";
import {
  CustomerMetadataWrite,
  CustomerMetadataDefaultEmpty,
} from "@tokenpanel/contracts/effect";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  DateFromSelf,
  DateFromUnknown,
  TimestampFields,
  Money,
  MoneyMinor,
  CustomerBalance,
  CurrencyCode,
  Email,
  LowercaseEmail,
  exactOptional,
  exactNullish,
  maxString,
  boundedString,
  SafeInt,
} from "./primitives.ts";

export const CustomerStatus = Schema.Literal("active", "suspended", "closed");

export const CustomerDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  externalId: exactNullish(maxString(128)),
  name: boundedString(1, 160),
  email: exactNullish(Email),
  balance: Schema.optionalWith(CustomerBalance, {
    default: () => ({
      amountMinor: 0,
      reservedMinor: 0,
      currency: "USD",
    }),
  }),
  status: Schema.optionalWith(CustomerStatus, {
    default: () => "active" as const,
  }),
  metadata: CustomerMetadataDefaultEmpty,
  ...TimestampFields,
});

export const CustomerCreateInput = Schema.Struct({
  externalId: exactOptional(maxString(128)),
  name: boundedString(1, 160),
  email: exactOptional(LowercaseEmail),
  startingBalance: exactOptional(Money),
  metadata: exactOptional(CustomerMetadataWrite),
});

export const CustomerUpdateInput = Schema.Struct({
  externalId: exactNullish(maxString(128)),
  name: exactOptional(boundedString(1, 160)),
  email: exactNullish(LowercaseEmail),
  status: exactOptional(CustomerStatus),
  metadata: exactOptional(CustomerMetadataWrite),
});

export const BalanceAdjustmentReason = Schema.Literal(
  "topup",
  "usage_debit",
  "refund",
  "adjustment",
  "overage",
);

export const BalanceAdjustmentDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  customerId: ObjectIdFromSelf,
  amountMinor: SafeInt,
  currency: CurrencyCode,
  reason: BalanceAdjustmentReason,
  usageRecordId: exactNullish(ObjectIdFromSelf),
  note: exactNullish(maxString(280)),
  occurredAt: DateFromSelf,
  ...TimestampFields,
});

export const BalanceAdjustmentCreateInput = Schema.Struct({
  customerId: ObjectIdFromString,
  amountMinor: SafeInt,
  currency: CurrencyCode,
  reason: BalanceAdjustmentReason,
  usageRecordId: exactOptional(ObjectIdFromString),
  note: exactOptional(maxString(280)),
  occurredAt: exactOptional(DateFromUnknown),
});

export type CustomerDoc = Schema.Schema.Type<typeof CustomerDoc>;
export type CustomerCreateInput = Schema.Schema.Type<typeof CustomerCreateInput>;
export type CustomerUpdateInput = Schema.Schema.Type<typeof CustomerUpdateInput>;
export type BalanceAdjustmentDoc = Schema.Schema.Type<
  typeof BalanceAdjustmentDoc
>;
export type BalanceAdjustmentCreateInput = Schema.Schema.Type<
  typeof BalanceAdjustmentCreateInput
>;

export { MoneyMinor };
