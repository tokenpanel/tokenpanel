import { Hono } from "hono";
import { Effect } from "effect";
import { ObjectId } from "mongodb";
import { providerCreateInput, providerUpdateInput } from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  maskProvider,
} from "../domains/providers/operations.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { sValidator } from "../http/validation/validator.ts";
import { listAdapters } from "../providers/registry.ts";
import { isAppError } from "../errors/families.ts";
import { parseObjectIdParam } from "./route-utils.ts";

export { maskProvider, parseObjectIdParam };

const providerRoutes = new Hono<{ Variables: AuthVariables }>();

providerRoutes.use("*", requireAuth);

providerRoutes.get("/adapters", requirePermission("providers:read"), (c) => {
  return c.json({ items: listAdapters() });
});

providerRoutes.get("/", requirePermission("providers:read"), async (c) => {
  const orgId = c.get("orgId");
  return runAdminEffect(
    c,
    listProviders(orgId.toHexString()).pipe(
      Effect.map((items) => ({ items })),
    ),
    { operation: "listProviders" },
  );
});

providerRoutes.post(
  "/",
  requirePermission("providers:write"),
  sValidator("json", providerCreateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    const known = new Set(listAdapters());
    return runAdminEffect(
      c,
      createProvider({
        organizationId: orgId.toHexString(),
        name: body.name,
        sdkType: body.sdkType,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        providerOrg: body.providerOrg,
        headers: body.headers,
        metadata: body.metadata,
        isKnownSdkType: (t) => known.has(t),
      }),
      { operation: "createProvider", successStatus: 201 },
    );
  },
);

providerRoutes.get("/:id", requirePermission("providers:read"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
  return runAdminEffect(
    c,
    getProvider({
      organizationId: orgId.toHexString(),
      providerId: id,
    }),
    { operation: "getProvider" },
  );
});

providerRoutes.patch(
  "/:id",
  requirePermission("providers:write"),
  sValidator("json", providerUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const known = new Set(listAdapters());
    return runAdminEffect(
      c,
      updateProvider({
        organizationId: orgId.toHexString(),
        providerId: id,
        patch: body,
        isKnownSdkType: (t) => known.has(t),
      }),
      { operation: "updateProvider" },
    );
  },
);

providerRoutes.delete(
  "/:id",
  requirePermission("providers:write"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runAdminEffect(
      c,
      deleteProvider({
        organizationId: orgId.toHexString(),
        providerId: id,
      }),
      {
        operation: "deleteProvider",
        mapError: (err) => {
          if (
            isAppError(err) &&
            err._tag === "ConflictError" &&
            err.code === "provider_in_use"
          ) {
            return {
              status: 409,
              body: { error: "provider_in_use", message: err.message },
              headers: {},
            };
          }
          return null;
        },
      },
    );
  },
);

export default providerRoutes;
