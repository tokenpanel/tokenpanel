import { Hono } from "hono";
import { Effect } from "effect";
import { ObjectId } from "mongodb";
import {
  organizationApiCreateInput,
  organizationApiUpdateInput,
  type OrganizationDoc,
} from "@tokenpanel/db";
import { requireAuth, type AuthVariables } from "../middleware/auth.ts";
import {
  listOrganizationsForUser,
  createOrganization,
  getOrganization,
  updateOrganization,
  deleteOrganization,
  deriveSlug,
  toOrganizationView,
} from "../domains/organizations/operations.ts";
import { switchActiveOrganization } from "../domains/auth/operations.ts";
import { OrganizationRepository } from "../domains/ports/organization-repository.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { sValidator } from "../http/validation/validator.ts";
import { isAppError } from "../errors/families.ts";

export const organizationRoutes = new Hono<{ Variables: AuthVariables }>();

organizationRoutes.use("*", requireAuth);

/** Response shape for an organization doc (no ObjectId/Date leaking). */
export function toResponse(doc: OrganizationDoc) {
  return toOrganizationView(doc);
}

export { deriveSlug };

// List orgs the authenticated user belongs to, with their per-org role.
organizationRoutes.get("/", async (c) => {
  const user = c.get("user");
  return runAdminEffect(c, listOrganizationsForUser(user), {
    operation: "listOrganizations",
  });
});

organizationRoutes.post(
  "/",
  sValidator("json", organizationApiCreateInput),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      createOrganization({
        userId: user._id.toHexString(),
        name: body.name,
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.defaultCurrency !== undefined
          ? { defaultCurrency: body.defaultCurrency }
          : {}),
      }).pipe(
        Effect.map((r) => ({
          organization: r.organization,
          token: r.token,
        })),
      ),
      { operation: "createOrganization", successStatus: 201 },
    );
  },
);

organizationRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    getOrganization({ user, organizationId: id }),
    { operation: "getOrganization" },
  );
});

organizationRoutes.patch(
  "/:id",
  sValidator("json", organizationApiUpdateInput),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      updateOrganization({
        user,
        organizationId: id,
        patch: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          ...(body.defaultCurrency !== undefined
            ? { defaultCurrency: body.defaultCurrency }
            : {}),
        },
      }),
      { operation: "updateOrganization" },
    );
  },
);

organizationRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    Effect.gen(function* () {
      const orgs = yield* OrganizationRepository;
      // Capture counts before delete for org_not_empty contract.
      const counts = yield* orgs.countBusinessData(id);
      return yield* deleteOrganization({ user, organizationId: id }).pipe(
        Effect.mapError((e) => {
          if (
            isAppError(e) &&
            e._tag === "ConflictError" &&
            e.code === "org_not_empty"
          ) {
            return Object.assign(e, { _counts: counts });
          }
          return e;
        }),
      );
    }),
    {
      operation: "deleteOrganization",
      mapError: (err) => {
        if (!isAppError(err)) return null;
        if (err._tag === "ConflictError" && err.code === "org_not_empty") {
          const counts = (err as { _counts?: unknown })._counts;
          return {
            status: 409,
            body: {
              error: "org_not_empty",
              ...(counts !== undefined ? { counts } : {}),
            },
            headers: {},
          };
        }
        if (err._tag === "ConflictError" && err.code === "last_org") {
          return {
            status: 409,
            body: {
              error: "last_org",
              message: "cannot delete your only organization",
            },
            headers: {},
          };
        }
        if (
          err._tag === "AuthorizationError" &&
          err.reason === "not_owner"
        ) {
          return {
            status: 403,
            body: { error: "forbidden", reason: "not_owner" },
            headers: {},
          };
        }
        return null;
      },
    },
  );
});

organizationRoutes.post("/switch", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as {
    organizationId?: string;
  } | null;
  const targetId = body?.organizationId;
  if (!targetId || !ObjectId.isValid(targetId)) {
    return c.json({ error: "invalid_organization_id" }, 400);
  }
  return runAdminEffect(
    c,
    Effect.gen(function* () {
      const switched = yield* switchActiveOrganization({
        userId: user._id.toHexString(),
        targetOrganizationId: targetId,
        memberships: user.memberships,
      });
      const orgs = yield* OrganizationRepository;
      const org = yield* orgs.findById(targetId);
      return {
        token: switched.token,
        role: switched.role,
        activeOrganizationId: switched.activeOrganizationId,
        organization: org
          ? { ...toOrganizationView(org, switched.role) }
          : null,
      };
    }),
    {
      operation: "switchOrganization",
      mapError: (err) => {
        if (!isAppError(err)) return null;
        if (
          err._tag === "AuthorizationError" &&
          err.reason === "not_a_member"
        ) {
          return {
            status: 403,
            body: { error: "forbidden", reason: "not_a_member" },
            headers: {},
          };
        }
        return null;
      },
    },
  );
});

export default organizationRoutes;
