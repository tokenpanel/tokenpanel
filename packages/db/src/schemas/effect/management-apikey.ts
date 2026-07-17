/**
 * Management API key Effect schemas.
 */
import { Schema } from "effect";
import {
  ManagementScopeSchema,
  MANAGEMENT_SCOPES,
  type ManagementScope,
} from "@tokenpanel/contracts/effect";
import {
  ObjectIdFromSelf,
  DateFromSelf,
  TimestampFields,
  exactOptional,
  exactNullish,
  boundedString,
} from "./primitives.ts";

export const managementScope = ManagementScopeSchema;
export type { ManagementScope };
export { MANAGEMENT_SCOPES };

export const ManagementApiKeyStatus = Schema.Literal("active", "revoked");

export const ManagementApiKeyDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  name: boundedString(1, 120),
  prefix: boundedString(8, 20),
  keyHash: Schema.String.pipe(Schema.minLength(1)),
  scopes: Schema.optionalWith(Schema.Array(ManagementScopeSchema), {
    default: () => [] as ManagementScope[],
  }),
  status: Schema.optionalWith(ManagementApiKeyStatus, {
    default: () => "active" as const,
  }),
  lastUsedAt: exactNullish(DateFromSelf),
  ...TimestampFields,
});

export const ManagementApiKeyCreateInput = Schema.Struct({
  name: boundedString(1, 120),
  scopes: Schema.optionalWith(Schema.Array(ManagementScopeSchema), {
    default: () => [] as ManagementScope[],
  }),
});

export const ManagementApiKeyUpdateInput = Schema.Struct({
  name: exactOptional(boundedString(1, 120)),
  scopes: exactOptional(Schema.Array(ManagementScopeSchema)),
  status: exactOptional(ManagementApiKeyStatus),
});

export type ManagementApiKeyDoc = Schema.Schema.Type<
  typeof ManagementApiKeyDoc
>;
export type ManagementApiKeyCreateInput = Schema.Schema.Type<
  typeof ManagementApiKeyCreateInput
>;
export type ManagementApiKeyUpdateInput = Schema.Schema.Type<
  typeof ManagementApiKeyUpdateInput
>;
