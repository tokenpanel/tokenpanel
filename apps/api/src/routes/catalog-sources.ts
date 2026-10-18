import { Hono } from "hono";
import { Effect } from "effect";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { getSource, listModels, listSources } from "../catalog-sources/index.ts";
import { NotFoundError, ProviderUnavailableError } from "../errors/families.ts";

export const catalogSourceRoutes = new Hono<{ Variables: AuthVariables }>();

catalogSourceRoutes.use("*", requireAuth);

catalogSourceRoutes.get(
  "/",
  requirePermission("catalog_sources:read"),
  async (c) => {
    return runAdminEffect(
      c,
      Effect.succeed({ items: listSources() }),
      { operation: "listCatalogSources" },
    );
  },
);

catalogSourceRoutes.get(
  "/:id/models",
  requirePermission("catalog_sources:read"),
  async (c) => {
    const id = c.req.param("id");
    return runAdminEffect(
      c,
      Effect.gen(function* () {
        if (!getSource(id)) {
          return yield* Effect.fail(
            new NotFoundError({
              code: "not_found",
              message: "Catalog source not found",
              resource: "catalog_source",
              id,
            }),
          );
        }
        const items = yield* Effect.tryPromise({
          try: () => listModels(id),
          catch: (err) =>
            // Admin-only route: the standard shows this message plus the
            // redacted diagnostic as `upstream.detail` for debugging.
            new ProviderUnavailableError({
              code: "provider_unavailable",
              message: "Failed to fetch models from catalog source",
              category: "connection",
              phase: "request",
              retryClass: "transient",
              fallbackClass: "ineligible",
              acceptanceClass: "not_accepted",
              streamCommitClass: "not_committed",
              diagnostic:
                err instanceof Error
                  ? `catalog_source_upstream: ${err.message}`
                  : `catalog_source_upstream: ${String(err)}`,
            }),
        });
        return { items };
      }),
      {
        operation: "listCatalogSourceModels",
      },
    );
  },
);

export default catalogSourceRoutes;
