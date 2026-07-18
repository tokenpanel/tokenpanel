/**
 * Customer + balance-adjustment Effect schemas.
 */
import { ParseResult, Schema } from "effect";
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
  MoneyUnits,
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

function strictStruct<A, I, R>(
  inner: Schema.Schema<A, I, R>,
  allowed: readonly string[],
  message: string,
): Schema.Schema<A, unknown, R> {
  const allowedSet = new Set(allowed);
  const excessGuard = Schema.transformOrFail(Schema.Unknown, Schema.Unknown, {
    strict: true,
    decode: (input, _opts, ast) => {
      if (
        input !== null &&
        typeof input === "object" &&
        !Array.isArray(input)
      ) {
        const extra = Object.keys(input).filter((k) => !allowedSet.has(k));
        if (extra.length > 0) {
          return ParseResult.fail(
            new ParseResult.Type(ast, input, `${message} [${extra.join(", ")}]`),
          );
        }
      }
      return ParseResult.succeed(input);
    },
    encode: ParseResult.succeed,
  });
  return Schema.compose(excessGuard, inner);
}

export const CustomerDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  externalId: exactNullish(maxString(128)),
  name: boundedString(1, 160),
  email: exactNullish(Email),
  balance: Schema.optionalWith(CustomerBalance, {
    default: () => ({
      amountUnits: 0,
      reservedUnits: 0,
      currency: "USD",
    }),
  }),
  status: Schema.optionalWith(CustomerStatus, {
    default: () => "active" as const,
  }),
  metadata: CustomerMetadataDefaultEmpty,
  ...TimestampFields,
});

export const CustomerCreateInput = strictStruct(
  Schema.Struct({
    externalId: exactOptional(maxString(128)),
    name: boundedString(1, 160),
    email: exactOptional(LowercaseEmail),
    metadata: exactOptional(CustomerMetadataWrite),
  }),
  ["externalId", "name", "email", "metadata"],
  "Unknown field — did you mean to use the balance adjust endpoint? startingBalance is no longer accepted at create time",
);

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
  amountUnits: SafeInt,
  currency: CurrencyCode,
  reason: BalanceAdjustmentReason,
  usageRecordId: exactNullish(ObjectIdFromSelf),
  note: exactNullish(maxString(280)),
  occurredAt: DateFromSelf,
  ...TimestampFields,
});

export const BalanceAdjustmentCreateInput = Schema.Struct({
  customerId: ObjectIdFromString,
  amountUnits: SafeInt,
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

export { MoneyUnits };
