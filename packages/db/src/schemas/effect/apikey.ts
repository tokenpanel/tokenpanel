/**
 * Customer API key Effect schemas.
 */
import { Schema } from "effect";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  DateFromSelf,
  TimestampFields,
  exactOptional,
  exactNullish,
  boundedString,
} from "./primitives.ts";

export const ApiKeyStatus = Schema.Literal("active", "revoked");

const ModelIdEntry = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80));

export const ApiKeyDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  customerId: ObjectIdFromSelf,
  name: boundedString(1, 120),
  prefix: boundedString(8, 20),
  keyHash: Schema.String.pipe(Schema.minLength(1)),
  modelWhitelist: Schema.optionalWith(Schema.Array(ModelIdEntry), {
    default: () => [] as string[],
  }),
  status: Schema.optionalWith(ApiKeyStatus, {
    default: () => "active" as const,
  }),
  lastUsedAt: exactNullish(DateFromSelf),
  ...TimestampFields,
});

export const ApiKeyCreateInput = Schema.Struct({
  customerId: ObjectIdFromString,
  name: boundedString(1, 120),
  modelWhitelist: exactOptional(Schema.Array(ModelIdEntry)),
});

export const ApiKeyUpdateInput = Schema.Struct({
  name: exactOptional(boundedString(1, 120)),
  modelWhitelist: exactOptional(Schema.Array(ModelIdEntry)),
  status: exactOptional(ApiKeyStatus),
});

export type ApiKeyDoc = Schema.Schema.Type<typeof ApiKeyDoc>;
export type ApiKeyCreateInput = Schema.Schema.Type<typeof ApiKeyCreateInput>;
export type ApiKeyUpdateInput = Schema.Schema.Type<typeof ApiKeyUpdateInput>;
