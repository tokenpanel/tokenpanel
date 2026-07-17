/**
 * Admin session schemas — Effect Schema production path.
 */
import {
  AdminSessionDoc as AdminSessionDocSchema,
  AdminSessionCreateInput as AdminSessionCreateInputSchema,
} from "./effect/session.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export const adminSessionDoc = withParseApi(AdminSessionDocSchema);
export const adminSessionCreateInput = withParseApi(
  AdminSessionCreateInputSchema,
);
export type AdminSessionDoc = MutableDeep<
  Schema.Schema.Type<typeof AdminSessionDocSchema>
>;
export type AdminSessionCreateInput = MutableDeep<
  Schema.Schema.Type<typeof AdminSessionCreateInputSchema>
>;
