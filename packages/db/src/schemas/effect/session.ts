/**
 * Admin panel session allowlist (JWT sid → server-side row).
 * JWT carries sid; revocation is delete/TTL of this document.
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
  /** Absolute expiry; Mongo TTL index deletes after this instant. */
  expiresAt: DateFromSelf,
  ...TimestampFields,
});

export const AdminSessionCreateInput = Schema.Struct({
  userId: ObjectIdFromString,
  expiresAt: DateFromSelf,
});

export type AdminSessionDoc = Schema.Schema.Type<typeof AdminSessionDoc>;
export type AdminSessionCreateInput = Schema.Schema.Type<
  typeof AdminSessionCreateInput
>;
