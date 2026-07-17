/**
 * Admin panel session allowlist (JWT sid → server-side row).
 * JWT carries sid; revocation is delete/TTL of this document.
 *
 * Tenant context is per-session (`organizationId`), not per-user.
 * Switching org updates this row + re-issues JWT for the current device only;
 * other sessions keep their own organizationId.
 */
import { Schema } from "effect";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  DateFromSelf,
  TimestampFields,
} from "./primitives.ts";

export const AdminSessionDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  userId: ObjectIdFromSelf,
  /** Active tenant for this session (independent of user.activeOrganizationId). */
  organizationId: ObjectIdFromSelf,
  /** Absolute expiry; Mongo TTL index deletes after this instant. */
  expiresAt: DateFromSelf,
  ...TimestampFields,
});

export const AdminSessionCreateInput = Schema.Struct({
  userId: ObjectIdFromString,
  organizationId: ObjectIdFromString,
  expiresAt: DateFromSelf,
});

export type AdminSessionDoc = Schema.Schema.Type<typeof AdminSessionDoc>;
export type AdminSessionCreateInput = Schema.Schema.Type<
  typeof AdminSessionCreateInput
>;
