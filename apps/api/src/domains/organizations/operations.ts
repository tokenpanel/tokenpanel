/**
 * Organization lifecycle operations (task 8.2).
 */
import { Effect } from "effect";
import type { OrganizationDoc, UserDoc, UserRole } from "@tokenpanel/db";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ConfigurationError,
} from "../../errors/families.ts";
import type { RepoError, HexId } from "../ports/common.ts";
import { OrganizationRepository } from "../ports/organization-repository.ts";
import { UserRepository } from "../ports/user-repository.ts";
import { InviteRepository } from "../ports/invite-repository.ts";
import { KeyRepository } from "../ports/key-repository.ts";
import { SessionRepository } from "../ports/session-repository.ts";
import { Crypto } from "../../runtime/services/crypto.ts";
import { AppConfig } from "../../runtime/services/app-config.ts";
import { Clock } from "../../runtime/services/clock.ts";
import { hasPanelPermission } from "@tokenpanel/contracts";
import { roleForOrganization } from "../auth/authz.ts";
import { issueAdminToken } from "../auth/operations.ts";

export type OrgDomainError =
  | AuthorizationError
  | ConflictError
  | NotFoundError
  | ConfigurationError
  | RepoError;

export type OrganizationView = {
  readonly id: HexId;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: HexId;
  readonly defaultCurrency: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly role?: UserRole | null | undefined;
};

export function toOrganizationView(
  doc: OrganizationDoc,
  role?: UserRole | null,
): OrganizationView {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    slug: doc.slug,
    ownerId: doc.ownerId.toHexString(),
    defaultCurrency: doc.defaultCurrency,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    ...(role !== undefined ? { role } : {}),
  };
}

/** Derive a lowercase-hyphenated slug from a name. */
export function deriveSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

function allocateUniqueSlug(
  base: string,
): Effect.Effect<string, RepoError, OrganizationRepository | Crypto> {
  return Effect.gen(function* () {
    const orgs = yield* OrganizationRepository;
    const crypto = yield* Crypto;
    let slug = base;
    for (let i = 0; i < 32; i++) {
      const taken = yield* orgs.slugTaken(slug);
      if (!taken) return slug;
      const suffix = yield* crypto.randomToken(2);
      slug = `${base}-${suffix}`;
    }
    const suffix = yield* crypto.randomToken(4);
    return `${base}-${suffix}`;
  });
}

export const listOrganizationsForUser = (
  user: UserDoc,
): Effect.Effect<
  {
    readonly items: readonly OrganizationView[];
    readonly activeOrganizationId: HexId;
  },
  RepoError,
  OrganizationRepository
> =>
  Effect.gen(function* () {
    const orgs = yield* OrganizationRepository;
    const ids = user.memberships.map((m) => m.organizationId.toHexString());
    const docs = yield* orgs.findByIds(ids);
    const items = docs.map((d) =>
      toOrganizationView(d, roleForOrganization(user.memberships, d._id.toHexString())),
    );
    return {
      items,
      activeOrganizationId: user.activeOrganizationId.toHexString(),
    };
  });

export const createOrganization = (input: {
  readonly userId: HexId;
  readonly name: string;
  readonly slug?: string | undefined;
  readonly defaultCurrency?: string | undefined;
  /** Reuse current allowlist session when re-issuing JWT. */
  readonly sessionId?: string | undefined;
}): Effect.Effect<
  { organization: OrganizationView; token: string },
  OrgDomainError,
  | OrganizationRepository
  | UserRepository
  | SessionRepository
  | Crypto
  | AppConfig
  | Clock
> =>
  Effect.gen(function* () {
    const orgs = yield* OrganizationRepository;
    const users = yield* UserRepository;

    const baseSlug = input.slug ?? deriveSlug(input.name);
    const slug = yield* allocateUniqueSlug(baseSlug);
    const org = yield* orgs
      .insert({
        name: input.name,
        slug,
        ownerId: input.userId,
        defaultCurrency: input.defaultCurrency ?? "USD",
      })
      .pipe(
        Effect.mapError((e) =>
          e._tag === "PersistenceDuplicateKeyError"
            ? new ConflictError({
                code: "organization_creation_failed",
                message: "Organization creation failed",
              })
            : e,
        ),
      );

    yield* users.addMembership(
      input.userId,
      org._id.toHexString(),
      "admin",
      true,
    );

    const issued = yield* issueAdminToken({
      userId: input.userId,
      orgId: org._id.toHexString(),
      role: "admin",
      sessionId: input.sessionId,
    });
    return {
      organization: toOrganizationView(org, "admin"),
      token: issued.token,
    };
  });

export const getOrganization = (input: {
  readonly user: UserDoc;
  readonly organizationId: HexId;
}): Effect.Effect<OrganizationView, OrgDomainError, OrganizationRepository> =>
  Effect.gen(function* () {
    const role = roleForOrganization(
      input.user.memberships,
      input.organizationId,
    );
    if (!role) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Organization not found",
          resource: "organization",
          id: input.organizationId,
        }),
      );
    }
    const orgs = yield* OrganizationRepository;
    const doc = yield* orgs.findById(input.organizationId);
    if (!doc) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Organization not found",
          resource: "organization",
          id: input.organizationId,
        }),
      );
    }
    return toOrganizationView(doc, role);
  });

export const updateOrganization = (input: {
  readonly user: UserDoc;
  readonly organizationId: HexId;
  readonly patch: {
    readonly name?: string | undefined;
    readonly slug?: string | undefined;
    readonly defaultCurrency?: string | undefined;
  };
}): Effect.Effect<OrganizationView, OrgDomainError, OrganizationRepository> =>
  Effect.gen(function* () {
    const role = roleForOrganization(
      input.user.memberships,
      input.organizationId,
    );
    if (!role) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Organization not found",
          resource: "organization",
          id: input.organizationId,
        }),
      );
    }
    const membership = input.user.memberships.find(
      (m) => m.organizationId.toHexString() === input.organizationId,
    );
    const perms = membership?.permissions ?? [];
    if (!hasPanelPermission(role, perms, "organization:write")) {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Missing required permission",
          reason: "missing_permission",
          scope: "organization:write",
        }),
      );
    }
    const orgs = yield* OrganizationRepository;
    if (input.patch.slug !== undefined) {
      const taken = yield* orgs.slugTaken(
        input.patch.slug,
        input.organizationId,
      );
      if (taken) {
        return yield* Effect.fail(
          new ConflictError({
            code: "slug_taken",
            message: "Slug already taken",
            fields: ["slug"],
          }),
        );
      }
    }
    const updated = yield* orgs.update(input.organizationId, input.patch);
    if (!updated) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Organization not found",
          resource: "organization",
          id: input.organizationId,
        }),
      );
    }
    return toOrganizationView(updated, role);
  });

/**
 * Delete org: owner only, not last membership, no business data remaining.
 */
export const deleteOrganization = (input: {
  readonly user: UserDoc;
  readonly organizationId: HexId;
}): Effect.Effect<
  { ok: true },
  OrgDomainError,
  | OrganizationRepository
  | UserRepository
  | InviteRepository
  | KeyRepository
> =>
  Effect.gen(function* () {
    const role = roleForOrganization(
      input.user.memberships,
      input.organizationId,
    );
    if (!role) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Organization not found",
          resource: "organization",
          id: input.organizationId,
        }),
      );
    }
    const orgs = yield* OrganizationRepository;
    const org = yield* orgs.findById(input.organizationId);
    if (!org) {
      return yield* Effect.fail(
        new NotFoundError({
          code: "not_found",
          message: "Organization not found",
          resource: "organization",
          id: input.organizationId,
        }),
      );
    }
    if (org.ownerId.toHexString() !== input.user._id.toHexString()) {
      return yield* Effect.fail(
        new AuthorizationError({
          code: "forbidden",
          message: "Only the owner can delete this organization",
          reason: "not_owner",
        }),
      );
    }
    if (input.user.memberships.length <= 1) {
      return yield* Effect.fail(
        new ConflictError({
          code: "last_org",
          message: "cannot delete your only organization",
        }),
      );
    }
    const counts = yield* orgs.countBusinessData(input.organizationId);
    const total =
      counts.providers +
      counts.customers +
      counts.models +
      counts.plans +
      counts.apiKeys;
    if (total > 0) {
      return yield* Effect.fail(
        new ConflictError({
          code: "org_not_empty",
          message: "Organization still has business data",
        }),
      );
    }

    const users = yield* UserRepository;
    const members = yield* users.findMembersOfOrg(input.organizationId);
    for (const m of members) {
      const remaining = m.memberships.filter(
        (mm) => mm.organizationId.toHexString() !== input.organizationId,
      );
      if (remaining.length === 0) continue;
      const stillActive = remaining.some(
        (mm) =>
          mm.organizationId.toHexString() ===
          m.activeOrganizationId.toHexString(),
      );
      const nextActive = stillActive
        ? m.activeOrganizationId.toHexString()
        : remaining[0]!.organizationId.toHexString();
      yield* users.pullMembershipAndRepoint(
        m._id.toHexString(),
        input.organizationId,
        nextActive,
      );
    }

    const invites = yield* InviteRepository;
    const keys = yield* KeyRepository;
    // Management keys are not business data (empty-org gate ignores them) but
    // must not survive deletion — otherwise public auth still trusts the key.
    yield* keys.deleteManagementKeysByOrg(input.organizationId);
    yield* invites.deleteByOrg(input.organizationId);
    yield* orgs.delete(input.organizationId);
    return { ok: true as const };
  });
