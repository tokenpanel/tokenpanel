/**
 * Identity / auth / signup / invite wire Effect schemas.
 * Used by routes/auth, signup, invites via sValidator / safeParseSchema.
 */
import { ParseResult, Schema } from "effect";
import {
  Email,
  Username,
  Password,
  CredentialString,
  PanelPermissionSchema,
  exactOptional,
} from "@tokenpanel/contracts/effect";

export const LoginBody = Schema.Struct({
  username: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(60)),
  password: CredentialString,
});
export type LoginBody = Schema.Schema.Type<typeof LoginBody>;

export const UpdateMeBody = Schema.Struct({
  email: Email,
});
export type UpdateMeBody = Schema.Schema.Type<typeof UpdateMeBody>;

const ChangePasswordBase = Schema.Struct({
  currentPassword: CredentialString,
  newPassword: Password,
  confirmNewPassword: Password,
});

/** Cross-field password rules with deterministic issue paths. */
export const ChangePasswordBody = Schema.transformOrFail(
  ChangePasswordBase,
  ChangePasswordBase,
  {
    strict: true,
    decode: (input, _opts, ast) => {
      if (input.newPassword !== input.confirmNewPassword) {
        return ParseResult.fail(
          new ParseResult.Pointer(
            ["confirmNewPassword"],
            input,
            new ParseResult.Type(
              ast,
              input.confirmNewPassword,
              "Passwords do not match",
            ),
          ),
        );
      }
      if (input.newPassword === input.currentPassword) {
        return ParseResult.fail(
          new ParseResult.Pointer(
            ["newPassword"],
            input,
            new ParseResult.Type(
              ast,
              input.newPassword,
              "New password must differ from current",
            ),
          ),
        );
      }
      return ParseResult.succeed(input);
    },
    encode: ParseResult.succeed,
  },
);
export type ChangePasswordBody = Schema.Schema.Type<typeof ChangePasswordBody>;

const SignupBase = Schema.Struct({
  adminEmail: Email,
  adminUsername: Username,
  password: Password,
  confirmPassword: Password,
});

export const SignupBody = Schema.transformOrFail(SignupBase, SignupBase, {
  strict: true,
  decode: (input, _opts, ast) => {
    if (input.password !== input.confirmPassword) {
      return ParseResult.fail(
        new ParseResult.Pointer(
          ["confirmPassword"],
          input,
          new ParseResult.Type(
            ast,
            input.confirmPassword,
            "Passwords do not match",
          ),
        ),
      );
    }
    return ParseResult.succeed(input);
  },
  encode: ParseResult.succeed,
});
export type SignupBody = Schema.Schema.Type<typeof SignupBody>;

export const InviteBody = Schema.Struct({
  email: Email,
  role: exactOptional(Schema.Literal("admin", "member")),
  /** Member grants only; ignored when role is admin. Default empty (deny). */
  permissions: exactOptional(Schema.Array(PanelPermissionSchema)),
  ttlHours: exactOptional(
    Schema.Number.pipe(
      Schema.int(),
      Schema.positive(),
      Schema.lessThanOrEqualTo(720),
    ),
  ),
});
export type InviteBody = Schema.Schema.Type<typeof InviteBody>;

export const AcceptInviteBody = Schema.Struct({
  token: Schema.String.pipe(Schema.minLength(1)),
  username: Username,
  password: Password,
});
export type AcceptInviteBody = Schema.Schema.Type<typeof AcceptInviteBody>;
