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
import { ConflictError, isAppError } from "../errors/families.ts";
import { notFoundResponse, respondWithCode } from "../http/error-context.ts";

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
  const orgId = c.get("orgId");
  return runAdminEffect(
    c,
    listOrganizationsForUser(user, orgId.toHexString()),
    {
      operation: "listOrganizations",
    },
  );
});

organizationRoutes.post(
  "/",
  sValidator("json", organizationApiCreateInput),
  async (c) => {
    const user = c.get("user");
    const sessionId = c.get("sessionId");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      createOrganization({
        userId: user._id.toHexString(),
        name: body.name,
        sessionId,
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
  if (!ObjectId.isValid(id)) return notFoundResponse(c);
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
    if (!ObjectId.isValid(id)) return notFoundResponse(c);
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
  if (!ObjectId.isValid(id)) return notFoundResponse(c);
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
            return new ConflictError({
              code: e.code,
              message: e.message,
              ...(e.fields !== undefined ? { fields: e.fields } : {}),
              details: { counts },
            });
          }
          return e;
        }),
      );
    }),
    {
      operation: "deleteOrganization",
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
    return respondWithCode(
      c,
      "validation_error",
      () => c.json({ error: "invalid_organization_id" }, 400),
      {
        message: "organizationId must be a valid id.",
        details: { issues: [{ path: "organizationId", message: "Invalid id" }] },
      },
    );
  }
  const sessionId = c.get("sessionId");
  return runAdminEffect(
    c,
    Effect.gen(function* () {
      const switched = yield* switchActiveOrganization({
        userId: user._id.toHexString(),
        targetOrganizationId: targetId,
        sessionId,
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
    },
  );
});

export default organizationRoutes;
