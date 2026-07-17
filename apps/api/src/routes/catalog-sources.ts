import { Hono } from "hono";
import { Effect } from "effect";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { getSource, listModels, listSources } from "../catalog-sources/index.ts";
import { NotFoundError, SystemError } from "../errors/families.ts";

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
            new SystemError({
              code: "system_error",
              message: err instanceof Error ? err.message : String(err),
              diagnostic: "catalog_source_upstream",
            }),
        });
        return { items };
      }),
      {
        operation: "listCatalogSourceModels",
        mapError: (err) => {
          if (
            err &&
            typeof err === "object" &&
            "_tag" in err &&
            (err as { _tag: string })._tag === "SystemError"
          ) {
            const se = err as SystemError;
            return {
              status: 502,
              body: { error: "upstream_error", message: se.message },
              headers: {},
            };
          }
          return null;
        },
      },
    );
  },
);

export default catalogSourceRoutes;
