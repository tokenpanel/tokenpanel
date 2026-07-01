import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth } from "../middleware/auth.ts";
import { getSource, listModels, listSources } from "../catalog-sources/index.ts";

export const catalogSourceRoutes = new Hono<{ Variables: AuthVariables }>();

catalogSourceRoutes.use("*", requireAuth);

// List registered catalog sources (populates the Fetch dialog's Provider dropdown).
catalogSourceRoutes.get("/", (c) => {
  return c.json({ items: listSources() });
});

// Fetch all mapped models for a source. Cached in-memory on the backend so the
// dialog can re-open without re-hitting the upstream every time.
catalogSourceRoutes.get("/:id/models", async (c) => {
  const id = c.req.param("id");
  if (!getSource(id)) {
    return c.json({ error: "not_found" }, 404);
  }
  try {
    const items = await listModels(id);
    return c.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "upstream_error", message }, 502);
  }
});

export default catalogSourceRoutes;
