import { Hono } from "hono";
import { Effect } from "effect";
import { ObjectId } from "mongodb";
import {
  managementApiKeyCreateInput,
  managementApiKeyUpdateInput,
} from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requireRole } from "../middleware/auth.ts";
import {
  listManagementKeys,
  issueManagementKey,
  updateManagementKey,
  revokeManagementKey,
  stripManagementKey,
} from "../domains/keys/operations.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "../domains/keys/policy.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { sValidator } from "../http/validation/validator.ts";
import { ManagementKeyListQuery } from "../http/validation/query.ts";
import { withParseApi } from "../http/validation/with-parse-api.ts";
import { KeyRepository } from "../domains/ports/key-repository.ts";
import { NotFoundError } from "../errors/families.ts";
import { parseObjectIdParam } from "./route-utils.ts";

/** @deprecated Test helper alias. */
export const stripKey = stripManagementKey;
export { parseObjectIdParam };
export const KEY_PREFIX_LITERAL = MANAGEMENT_KEY_PREFIX_LITERAL;
export const PREFIX_LENGTH = API_KEY_LOOKUP_PREFIX_CHARS;

export const managementKeyListQuery = withParseApi(ManagementKeyListQuery);

const managementKeyRoutes = new Hono<{ Variables: AuthVariables }>();

managementKeyRoutes.use("*", requireAuth);

managementKeyRoutes.get(
  "/",
  sValidator("query", managementKeyListQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const q = c.req.valid("query");
    return runAdminEffect(
      c,
      listManagementKeys({
        organizationId: orgId.toHexString(),
        ...(q.status !== undefined ? { status: q.status } : {}),
      }).pipe(Effect.map((items) => ({ items }))),
      { operation: "listManagementKeys" },
    );
  },
);

managementKeyRoutes.post(
  "/",
  requireRole("admin"),
  sValidator("json", managementApiKeyCreateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      issueManagementKey({
        organizationId: orgId.toHexString(),
        name: body.name,
        scopes: body.scopes,
      }).pipe(
        Effect.map((r) => ({
          ...r.managementKey,
          key: r.key,
        })),
      ),
      { operation: "issueManagementKey", successStatus: 201 },
    );
  },
);

managementKeyRoutes.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    Effect.gen(function* () {
      const keys = yield* KeyRepository;
      const doc = yield* keys.findManagementKey(orgId.toHexString(), id);
      if (!doc) {
        return yield* Effect.fail(
          new NotFoundError({
            code: "not_found",
            message: "Management key not found",
            resource: "management_key",
            id,
          }),
        );
      }
      return stripManagementKey(doc);
    }),
    { operation: "getManagementKey" },
  );
});

managementKeyRoutes.patch(
  "/:id",
  requireRole("admin"),
  sValidator("json", managementApiKeyUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      updateManagementKey({
        organizationId: orgId.toHexString(),
        keyId: id,
        patch: body as Record<string, unknown>,
      }),
      { operation: "updateManagementKey" },
    );
  },
);

managementKeyRoutes.delete("/:id", requireRole("admin"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    revokeManagementKey({
      organizationId: orgId.toHexString(),
      keyId: id,
    }),
    { operation: "revokeManagementKey" },
  );
});

export default managementKeyRoutes;
