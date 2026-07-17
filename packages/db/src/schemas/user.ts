/**
 * User / invite / membership schemas — Effect Schema production path (§11).
 */
import {
  UserRole as UserRoleSchema,
  MembershipDoc as MembershipDocSchema,
  MembershipInput as MembershipInputSchema,
  UserStatus as UserStatusSchema,
  UserDoc as UserDocSchema,
  UserCreateInput as UserCreateInputSchema,
  UserUpdateInput as UserUpdateInputSchema,
  InviteStatus as InviteStatusSchema,
  InviteDoc as InviteDocSchema,
  InviteCreateInput as InviteCreateInputSchema,
} from "./effect/identity.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export const userRole = withParseApi(UserRoleSchema);
export type UserRole = Schema.Schema.Type<typeof UserRoleSchema>;

/** Re-export panel permission atom (canonical catalog lives in contracts). */
export type { PanelPermission } from "./effect/identity.ts";

export const membershipDoc = withParseApi(MembershipDocSchema);
export const membershipInput = withParseApi(MembershipInputSchema);
export type MembershipDoc = MutableDeep<Schema.Schema.Type<typeof MembershipDocSchema>>;
export type MembershipInput = MutableDeep<Schema.Schema.Type<typeof MembershipInputSchema>>;

export const userStatus = withParseApi(UserStatusSchema);
export const userDoc = withParseApi(UserDocSchema);
export const userCreateInput = withParseApi(UserCreateInputSchema);
export const userUpdateInput = withParseApi(UserUpdateInputSchema);
export type UserDoc = MutableDeep<Schema.Schema.Type<typeof UserDocSchema>>;
export type UserCreateInput = MutableDeep<Schema.Schema.Type<typeof UserCreateInputSchema>>;
export type UserUpdateInput = MutableDeep<Schema.Schema.Type<typeof UserUpdateInputSchema>>;

export const inviteStatus = withParseApi(InviteStatusSchema);
export const inviteDoc = withParseApi(InviteDocSchema);
export const inviteCreateInput = withParseApi(InviteCreateInputSchema);
export type InviteDoc = MutableDeep<Schema.Schema.Type<typeof InviteDocSchema>>;
export type InviteCreateInput = MutableDeep<Schema.Schema.Type<typeof InviteCreateInputSchema>>;
