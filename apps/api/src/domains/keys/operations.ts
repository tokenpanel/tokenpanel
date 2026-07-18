/**
 * Customer + management API key issuance/update (task 8.5).
 * Prefix collision / secret policy centralized here + keys/policy.
 */
import { Effect } from "effect";
import type {
  ApiKeyDoc,
  ManagementApiKeyDoc,
  ManagementApiKeyUpdateInput,
  ManagementScope,
} from "@tokenpanel/db";
import type { PanelPermission } from "@tokenpanel/contracts";
import { canGrantManagementScopes } from "@tokenpanel/contracts";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  SystemError,
  ValidationError,
} from "../../errors/families.ts";
import type { HexId, PageResult, RepoError } from "../ports/common.ts";
import { KeyRepository } from "../ports/key-repository.ts";
import { CustomerRepository } from "../ports/customer-repository.ts";
import { Crypto } from "../../runtime/services/crypto.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT,
  API_KEY_SECRET_BYTES,
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "./policy.ts";

export type KeyDomainError =
  | AuthorizationError
  | ConflictError
  | NotFoundError
  | SystemError
  | ValidationError
  | RepoError;

export type StrippedCustomerKey = Omit<ApiKeyDoc, "keyHash"> & {
  readonly hasKey: true;
};
export type StrippedManagementKey = Omit<ManagementApiKeyDoc, "keyHash"> & {
  readonly hasKey: true;
};

export function stripCustomerKey(doc: ApiKeyDoc): StrippedCustomerKey {
  const { keyHash: _omit, ...rest } = doc;
  void _omit;
  return { ...rest, hasKey: true };
}

export type CustomerKeyPublic = Omit<StrippedCustomerKey, "customerId">;

export function stripCustomerKeyMeta(
  doc: StrippedCustomerKey,
): CustomerKeyPublic {
  const { customerId: _omit, ...rest } = doc;
  void _omit;
  return rest;
}

export function stripManagementKey(
  doc: ManagementApiKeyDoc,
): StrippedManagementKey {
  const { keyHash: _omit, ...rest } = doc;
  void _omit;
  return { ...rest, hasKey: true };
}

type IssuedMaterial = {
  readonly fullKey: string;
  readonly prefix: string;
  readonly keyHash: string;
};

function buildKeyMaterial(
  literal: string,
  randomHex: string,
  keyHash: string,
): IssuedMaterial {
  const fullKey = `${literal}${randomHex}`;
  const prefix = fullKey.slice(0, API_KEY_LOOKUP_PREFIX_CHARS);
  return { fullKey, prefix, keyHash };
}

/**
 * Issue key with bounded prefix-collision retry against repository insert.
 */
function issueWithRetry<A>(params: {
  readonly literal: string;
  readonly insert: (
    material: IssuedMaterial,
  ) => Effect.Effect<A, RepoError>;
}): Effect.Effect<
  { doc: A; fullKey: string },
  KeyDomainError,
  Crypto
> {
  return Effect.gen(function* () {
    const crypto = yield* Crypto;
    let lastDuplicate = false;
    for (let attempt = 0; attempt < API_KEY_PREFIX_COLLISION_ATTEMPTS_COUNT; attempt++) {
      const randomHex = yield* crypto.randomToken(API_KEY_SECRET_BYTES);
      const fullKey = `${params.literal}${randomHex}`;
      const keyHash = yield* crypto.hashToken(fullKey);
      const material = buildKeyMaterial(params.literal, randomHex, keyHash);
      const result = yield* params.insert(material).pipe(Effect.either);
      if (result._tag === "Right") {
        return { doc: result.right, fullKey: material.fullKey };
      }
      if (result.left._tag === "PersistenceDuplicateKeyError") {
        lastDuplicate = true;
        continue;
      }
      return yield* Effect.fail(result.left);
    }
    return yield* Effect.fail(
      new SystemError({
        code: "system_error",
        message: lastDuplicate
          ? "prefix_collision"
          : "key_issuance_failed",
        diagnostic: lastDuplicate ? "prefix_exhausted" : "unexpected_duplicate",
      }),
    );
  });
}

export const listCustomerApiKeys = (input: {
  readonly organizationId: HexId;
  readonly customerId?: HexId | undefined;
  readonly limit?: number | undefined;
  readonly skip?: number | undefined;
}): Effect.Effect<
  PageResult<StrippedCustomerKey>,
  KeyDomainError,
  KeyRepository
> =>
  Effect.gen(function* () {
    const keys = yield* KeyRepository;
    const page = yield* keys.listCustomerKeys(
      input.organizationId,
      input.customerId,
      { limit: input.limit, skip: input.skip },
    );
    return { items: page.items.map(stripCustomerKey), total: page.total };
  });

export const issueCustomerApiKey = (input: {
  readonly organizationId: HexId;
  readonly customerId: HexId;
  readonly name: string;
  readonly modelWhitelist?: readonly string[] | undefined;
}): Effect.Effect<
  { apiKey: StrippedCustomerKey; key: string },
  KeyDomainError,
  KeyRepository | CustomerRepository | Crypto
> =>
  Effect.gen(function* () {
    const customers = yield* CustomerRepository;
    const customer = yield* customers.findById(
      input.organizationId,
      input.customerId,
    );
    if (!customer) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "customer_not_found",
          message: "Customer not found",
          resource: "customer",
          id: input.customerId,
        }),
      );
    }
    const keys = yield* KeyRepository;
    const issued = yield* issueWithRetry({
      literal: CUSTOMER_KEY_PREFIX_LITERAL,
      insert: (material) =>
        keys.insertCustomerKey({
          organizationId: input.organizationId,
          customerId: input.customerId,
          name: input.name,
          prefix: material.prefix,
          keyHash: material.keyHash,
          modelWhitelist: input.modelWhitelist ?? [],
          status: "active",
        }),
    });
    return {
      apiKey: stripCustomerKey(issued.doc),
      key: issued.fullKey,
    };
  });

export const updateCustomerApiKey = (input: {
  readonly organizationId: HexId;
  readonly keyId: HexId;
  readonly patch: Record<string, unknown>;
}): Effect.Effect<
  StrippedCustomerKey,
  KeyDomainError,
  KeyRepository
> =>
  Effect.gen(function* () {
    const keys = yield* KeyRepository;
    const updated = yield* keys.updateCustomerKey(
      input.organizationId,
      input.keyId,
      input.patch,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "API key not found",
          resource: "api_key",
          id: input.keyId,
        }),
      );
    }
    return stripCustomerKey(updated);
  });

export const revokeCustomerApiKey = (input: {
  readonly organizationId: HexId;
  readonly keyId: HexId;
}): Effect.Effect<
  { ok: true; status: string },
  KeyDomainError,
  KeyRepository
> =>
  Effect.gen(function* () {
    const keys = yield* KeyRepository;
    const updated = yield* keys.revokeCustomerKey(
      input.organizationId,
      input.keyId,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "API key not found",
          resource: "api_key",
          id: input.keyId,
        }),
      );
    }
    return { ok: true as const, status: updated.status };
  });

export const listManagementKeys = (input: {
  readonly organizationId: HexId;
  readonly status?: "active" | "revoked" | undefined;
}): Effect.Effect<
  readonly StrippedManagementKey[],
  KeyDomainError,
  KeyRepository
> =>
  Effect.gen(function* () {
    const keys = yield* KeyRepository;
    const docs = yield* keys.listManagementKeys(
      input.organizationId,
      input.status,
    );
    return docs.map(stripManagementKey);
  });

export const issueManagementKey = (input: {
  readonly organizationId: HexId;
  readonly name: string;
  readonly scopes: readonly ManagementScope[];
  readonly actorRole: "admin" | "member";
  readonly actorPermissions: readonly PanelPermission[] | undefined;
}): Effect.Effect<
  { managementKey: StrippedManagementKey; key: string },
  KeyDomainError,
  KeyRepository | Crypto
> =>
  Effect.gen(function* () {
    if (
      !canGrantManagementScopes(
        input.actorRole,
        input.actorPermissions,
        input.scopes,
      )
    ) {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Cannot grant management scopes you do not hold",
          reason: "privilege_escalation",
        }),
      );
    }
    const keys = yield* KeyRepository;
    const issued = yield* issueWithRetry({
      literal: MANAGEMENT_KEY_PREFIX_LITERAL,
      insert: (material) =>
        keys.insertManagementKey({
          organizationId: input.organizationId,
          name: input.name,
          prefix: material.prefix,
          keyHash: material.keyHash,
          scopes: input.scopes,
          status: "active",
        }),
    });
    return {
      managementKey: stripManagementKey(issued.doc),
      key: issued.fullKey,
    };
  });

export const updateManagementKey = (input: {
  readonly organizationId: HexId;
  readonly keyId: HexId;
  readonly patch: ManagementApiKeyUpdateInput;
  readonly actorRole: "admin" | "member";
  readonly actorPermissions: readonly PanelPermission[] | undefined;
}): Effect.Effect<
  StrippedManagementKey,
  KeyDomainError,
  KeyRepository
> =>
  Effect.gen(function* () {
    const keys = yield* KeyRepository;
    const existing = yield* keys.findManagementKey(
      input.organizationId,
      input.keyId,
    );
    if (!existing) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Management key not found",
          resource: "management_key",
          id: input.keyId,
        }),
      );
    }
    let patch: ManagementApiKeyUpdateInput = input.patch;
    if (input.patch.scopes !== undefined) {
      const submittedScopes = input.patch.scopes;
      const existingScopes = existing.scopes;
      const lockedScopes = existingScopes.filter(
        (s) =>
          !canGrantManagementScopes(input.actorRole, input.actorPermissions, [s]),
      );
      const additions = submittedScopes.filter(
        (s) => !existingScopes.includes(s),
      );
      if (
        !canGrantManagementScopes(
          input.actorRole,
          input.actorPermissions,
          additions,
        )
      ) {
        return yield* Effect.fail(
          new AuthorizationError({
            code: "forbidden",
            message: "Cannot grant management scopes you do not hold",
            reason: "privilege_escalation",
          }),
        );
      }
      const finalScopes: ManagementScope[] = Array.from(
        new Set<ManagementScope>([
          ...lockedScopes,
          ...submittedScopes.filter((s) =>
            canGrantManagementScopes(input.actorRole, input.actorPermissions, [s]),
          ),
        ]),
      ).sort();
      patch = { ...input.patch, scopes: finalScopes };
    }
    const updated = yield* keys.updateManagementKey(
      input.organizationId,
      input.keyId,
      patch,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Management key not found",
          resource: "management_key",
          id: input.keyId,
        }),
      );
    }
    return stripManagementKey(updated);
  });

export const revokeManagementKey = (input: {
  readonly organizationId: HexId;
  readonly keyId: HexId;
}): Effect.Effect<
  { ok: true; status: string },
  KeyDomainError,
  KeyRepository
> =>
  Effect.gen(function* () {
    const keys = yield* KeyRepository;
    const updated = yield* keys.revokeManagementKey(
      input.organizationId,
      input.keyId,
    );
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Management key not found",
          resource: "management_key",
          id: input.keyId,
        }),
      );
    }
    return { ok: true as const, status: updated.status };
  });
