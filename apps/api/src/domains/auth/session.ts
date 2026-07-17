/**
 * Session / principal resolution (task 10.1).
 * Surface-agnostic Effect ops used by admin + public middleware.
 * Throttling remains a surface concern in HTTP middleware.
 */
import { Effect } from "effect";
import type {
  ApiKeyDoc,
  CustomerDoc,
  ManagementApiKeyDoc,
  UserDoc,
  UserRole,
} from "@tokenpanel/db";
import {
  AuthenticationError,
  AuthorizationError,
} from "../../errors/families.ts";
import type { RepoError } from "../ports/common.ts";
import { UserRepository } from "../ports/user-repository.ts";
import { KeyRepository } from "../ports/key-repository.ts";
import { CustomerRepository } from "../ports/customer-repository.ts";
import { Crypto } from "../../runtime/services/crypto.ts";
import { AppConfig } from "../../runtime/services/app-config.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "../../config/security-policy.ts";

export type SessionError =
  | AuthenticationError
  | AuthorizationError
  | RepoError;

export type AdminSession = {
  readonly user: UserDoc;
  readonly orgId: UserDoc["activeOrganizationId"];
  readonly role: UserRole;
};

export type ResolvedPublicPrincipal =
  | {
      readonly kind: "customer";
      readonly orgId: CustomerDoc["organizationId"];
      readonly customer: CustomerDoc;
      readonly apiKey: ApiKeyDoc;
      readonly prefix: string;
    }
  | {
      readonly kind: "management";
      readonly orgId: ManagementApiKeyDoc["organizationId"];
      readonly managementKey: ManagementApiKeyDoc;
      readonly prefix: string;
    };

const PREFIX_LENGTH = API_KEY_LOOKUP_PREFIX_CHARS;
const MIN_FULL_KEY_LENGTH = PREFIX_LENGTH;

function unauthorized(
  reason?: string,
): Effect.Effect<never, AuthenticationError> {
  return Effect.fail(
    new AuthenticationError({
      code: "unauthorized",
      message: "Unauthorized",
      ...(reason !== undefined ? { reason } : {}),
    }),
  );
}

/**
 * Resolve admin JWT → active user + org membership role.
 */
export const resolveAdminSession = (
  bearerToken: string | null,
): Effect.Effect<
  AdminSession,
  SessionError,
  UserRepository | Crypto | AppConfig
> =>
  Effect.gen(function* () {
    if (!bearerToken) {
      return yield* unauthorized();
    }
    const crypto = yield* Crypto;
    const config = yield* AppConfig;
    const payload = yield* crypto.verifyJwt(bearerToken, config.jwtSecret).pipe(
      Effect.mapError(
        (e) =>
          new AuthenticationError({
            code: "unauthorized",
            message: "Unauthorized",
            reason: e instanceof Error ? e.message : "invalid_token",
            privateReason: e instanceof Error ? e.message : String(e),
          }),
      ),
    );

    const users = yield* UserRepository;
    const user = yield* users.findById(payload.sub);
    if (!user) {
      return yield* unauthorized();
    }
    if (user.status !== "active") {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "user_disabled",
          message: "user disabled",
          reason: "user_disabled",
        }),
      );
    }
    const activeMembership = user.memberships.find((m) =>
      m.organizationId.equals(user.activeOrganizationId),
    );
    if (!activeMembership) {
      return yield* unauthorized("no_active_org_membership");
    }
    return {
      user,
      orgId: user.activeOrganizationId,
      role: activeMembership.role,
    };
  });

function classifyKey(fullKey: string): "customer" | "management" | null {
  if (fullKey.startsWith(CUSTOMER_KEY_PREFIX_LITERAL)) return "customer";
  if (fullKey.startsWith(MANAGEMENT_KEY_PREFIX_LITERAL)) return "management";
  return null;
}

/**
 * Authenticate a public Bearer API key (customer or management).
 * Does NOT apply brute-force throttle — middleware owns that.
 *
 * Customer status failures are AuthorizationError (403), not auth failures,
 * so middleware must not count them against the throttle.
 */
export const resolvePublicPrincipal = (
  authorizationHeader: string | undefined,
): Effect.Effect<
  ResolvedPublicPrincipal,
  SessionError,
  KeyRepository | CustomerRepository | Crypto
> =>
  Effect.gen(function* () {
    if (!authorizationHeader) {
      return yield* unauthorized();
    }
    const parts = authorizationHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return yield* unauthorized();
    }
    const fullKey = parts[1];
    if (!fullKey || fullKey.length < MIN_FULL_KEY_LENGTH) {
      return yield* unauthorized();
    }
    const kind = classifyKey(fullKey);
    if (kind === null) {
      return yield* unauthorized();
    }

    const crypto = yield* Crypto;
    const keys = yield* KeyRepository;
    const prefix = fullKey.slice(0, PREFIX_LENGTH);
    const keyHash = yield* crypto.hashToken(fullKey);

    if (kind === "customer") {
      const apiKey = yield* keys.findCustomerKeyByPrefix(prefix);
      if (!apiKey) return yield* unauthorized();
      const hashOk = yield* crypto.safeHashEqual(keyHash, apiKey.keyHash);
      if (!hashOk) return yield* unauthorized();
      if (apiKey.status !== "active") return yield* unauthorized();

      const customers = yield* CustomerRepository;
      const customer = yield* customers.findByCustomerId(
        apiKey.customerId.toHexString(),
      );
      if (!customer || customer.status !== "active") {
        // Key authenticated; customer cannot use API — 403, not 401.
        return yield* Effect.fail(
          new AuthorizationError({
            code: "forbidden",
            message: "Customer not active",
            reason: "customer_inactive",
          }),
        );
      }
      return {
        kind: "customer" as const,
        orgId: customer.organizationId,
        customer,
        apiKey,
        prefix,
      };
    }

    const managementKey = yield* keys.findManagementKeyByPrefix(prefix);
    if (!managementKey) return yield* unauthorized();
    const hashOk = yield* crypto.safeHashEqual(keyHash, managementKey.keyHash);
    if (!hashOk) return yield* unauthorized();
    if (managementKey.status !== "active") return yield* unauthorized();

    return {
      kind: "management" as const,
      orgId: managementKey.organizationId,
      managementKey,
      prefix,
    };
  });

/** Fire-and-forget lastUsedAt update after successful public auth. */
export const touchPublicKeyLastUsed = (
  principal: ResolvedPublicPrincipal,
): Effect.Effect<void, never, KeyRepository> =>
  Effect.gen(function* () {
    const keys = yield* KeyRepository;
    if (principal.kind === "customer") {
      yield* keys.touchCustomerKeyLastUsed(principal.prefix).pipe(
        Effect.catchAll(() => Effect.void),
      );
    } else {
      yield* keys.touchManagementKeyLastUsed(principal.prefix).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
  });

/**
 * Assert principal is management key (enumeration-safe: 401 not 403).
 */
export const requireManagementKind = (
  principal: ResolvedPublicPrincipal | undefined,
): Effect.Effect<
  Extract<ResolvedPublicPrincipal, { kind: "management" }>,
  AuthenticationError
> => {
  if (!principal || principal.kind !== "management") {
    return unauthorized();
  }
  return Effect.succeed(principal);
};
