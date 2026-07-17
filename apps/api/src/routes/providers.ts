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
  listProviderCatalog,
  discoverProviderModels,
  maskProvider,
} from "../domains/providers/operations.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { sValidator } from "../http/validation/validator.ts";
import { getAdapter, listAdapters } from "../providers/registry.ts";
import { isAppError } from "../errors/families.ts";
import { getApiRuntimeConfig } from "../config/state.ts";
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
        httpTimeoutMs: body.httpTimeoutMs,
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

/** Cached model_catalog for a provider (Discover / Models panel + model entry picker). */
providerRoutes.get(
  "/:id/models",
  requirePermission("providers:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runAdminEffect(
      c,
      listProviderCatalog({
        organizationId: orgId.toHexString(),
        providerId: id,
      }),
      { operation: "listProviderCatalog" },
    );
  },
);

/**
 * Hit upstream listModels with provider credentials, upsert model_catalog.
 * Requires providers:write (decrypts API key; drives paid/credentialed upstream).
 */
providerRoutes.post(
  "/:id/discover-models",
  requirePermission("providers:write"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const globalTimeoutMs =
      getApiRuntimeConfig().operational.providerHttpTimeoutMs;
    return runAdminEffect(
      c,
      discoverProviderModels({
        organizationId: orgId.toHexString(),
        providerId: id,
        getAdapter,
        globalTimeoutMs,
      }),
      { operation: "discoverProviderModels" },
    );
  },
);

export default providerRoutes;
