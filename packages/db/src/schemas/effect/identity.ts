/**
 * Identity Effect schemas: user, membership, invite, role.
 */
import { Schema } from "effect";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  DateFromSelf,
  TimestampFields,
  Email,
  Username,
  exactOptional,
  exactNullish,
} from "./primitives.ts";
import {
  Password as PasswordBound,
  CredentialString,
  PanelPermissionSchema,
} from "@tokenpanel/contracts/effect";

export const UserRole = Schema.Literal("admin", "member");
export type UserRole = Schema.Schema.Type<typeof UserRole>;

/** Panel permission atom (re-export of contracts catalog). */
export const PanelPermission = PanelPermissionSchema;
export type PanelPermission = Schema.Schema.Type<typeof PanelPermissionSchema>;

/**
 * Member grants. Empty by default (deny). Admins ignore this field —
 * effective permissions resolve to the full panel catalog.
 */
const MemberPermissions = Schema.optionalWith(
  Schema.Array(PanelPermissionSchema),
  { default: () => [] as const },
);

export const MembershipDoc = Schema.Struct({
  organizationId: ObjectIdFromSelf,
  role: UserRole,
  permissions: MemberPermissions,
});

export const MembershipInput = Schema.Struct({
  organizationId: ObjectIdFromString,
  role: UserRole,
  permissions: MemberPermissions,
});

export type MembershipDoc = Schema.Schema.Type<typeof MembershipDoc>;
export type MembershipInput = Schema.Schema.Type<typeof MembershipInput>;

export const UserStatus = Schema.Literal("active", "disabled");

export const UserDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  memberships: Schema.Array(MembershipDoc).pipe(Schema.minItems(1)),
  activeOrganizationId: ObjectIdFromSelf,
  username: Username,
  email: Email,
  passwordHash: Schema.String.pipe(Schema.minLength(1)),
  status: Schema.optionalWith(UserStatus, { default: () => "active" as const }),
  ...TimestampFields,
});

export const UserCreateInput = Schema.Struct({
  memberships: Schema.Array(MembershipInput).pipe(Schema.minItems(1)),
  activeOrganizationId: ObjectIdFromString,
  username: Username,
  email: Email,
  password: PasswordBound,
});

export const UserUpdateInput = Schema.Struct({
  email: exactOptional(Email),
  status: exactOptional(UserStatus),
});

export type UserDoc = Schema.Schema.Type<typeof UserDoc>;
export type UserCreateInput = Schema.Schema.Type<typeof UserCreateInput>;
export type UserUpdateInput = Schema.Schema.Type<typeof UserUpdateInput>;

export const InviteStatus = Schema.Literal("pending", "accepted", "revoked");

export const InviteDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  invitedBy: ObjectIdFromSelf,
  email: Email,
  role: Schema.optionalWith(UserRole, { default: () => "member" as const }),
  /** Applied when invite role is member; ignored for admin invites. */
  permissions: MemberPermissions,
  tokenHash: Schema.String.pipe(Schema.minLength(1)),
  status: Schema.optionalWith(InviteStatus, {
    default: () => "pending" as const,
  }),
  acceptedAt: exactNullish(DateFromSelf),
  expiresAt: DateFromSelf,
  ...TimestampFields,
});

export const InviteCreateInput = Schema.Struct({
  organizationId: ObjectIdFromString,
  invitedBy: ObjectIdFromString,
  email: Email,
  role: exactOptional(UserRole),
  permissions: exactOptional(Schema.Array(PanelPermissionSchema)),
  ttlHours: Schema.optionalWith(
    Schema.Number.pipe(
      Schema.int(),
      Schema.positive(),
      Schema.lessThanOrEqualTo(720),
    ),
    { default: () => 168 },
  ),
});

export type InviteDoc = Schema.Schema.Type<typeof InviteDoc>;
export type InviteCreateInput = Schema.Schema.Type<typeof InviteCreateInput>;

// Re-export password leaves for API wire reuse
export { PasswordBound as Password, CredentialString };
