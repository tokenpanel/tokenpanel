import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDb, ensureIndexes } from "@tokenpanel/db";
import type { AuthVariables } from "./middleware/auth.ts";
import authRoutes from "./routes/auth.ts";
import signupRoutes from "./routes/signup.ts";
import customers from "./routes/customers.ts";
import providers from "./routes/providers.ts";
import models from "./routes/models.ts";
import plans from "./routes/plans.ts";
import apiKeys from "./routes/api-keys.ts";
import inviteRoutes, { acceptInviteRoute } from "./routes/invites.ts";
import organizationRoutes from "./routes/organizations.ts";
import playgroundRoutes from "./routes/playground.ts";
import catalogSourceRoutes from "./routes/catalog-sources.ts";
import publicOpenAI from "./routes/public/openai.ts";
import publicAnthropic from "./routes/public/anthropic.ts";
import "./providers/index.ts";

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET not set. Add it to .env (random 32+ char string).");
  process.exit(1);
}

const app = new Hono<{ Variables: AuthVariables }>();

// Admin panel (apps/admin) and API (apps/api) run on separate origins in dev
// (e.g. localhost:5173 -> localhost:3000). Auth is JWT Bearer in Authorization
// header (no cookies), so reflecting the request Origin is safe and lets the
// browser read responses cross-origin. Restrict via CORS_ORIGINS in prod.
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : null;
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      if (allowedOrigins === null) return origin; // dev: reflect any
      return allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 600,
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/admin/auth", authRoutes);
app.route("/admin/auth", signupRoutes);
app.route("/admin/auth", acceptInviteRoute);
app.route("/admin/customers", customers);
app.route("/admin/providers", providers);
app.route("/admin/models", models);
app.route("/admin/plans", plans);
app.route("/admin/api-keys", apiKeys);
app.route("/admin/invites", inviteRoutes);
app.route("/admin/organizations", organizationRoutes);
app.route("/admin/playground", playgroundRoutes);
app.route("/admin/catalog-sources", catalogSourceRoutes);

app.route("/", publicOpenAI);
app.route("/", publicAnthropic);

// --- Static admin SPA (built by apps/admin via `vite build`) ---
// In prod the API serves the admin panel from the same port so you only need
// one domain. In dev, Vite serves the SPA separately (HMR) and proxies API
// routes here. serveStatic calls next() on miss, so it never shadows API
// routes above; this is registered last deliberately.
//
// resolve() makes the path cwd-independent: api runs from apps/api/, so
// ../admin/dist points at apps/admin/dist regardless of where Bun was launched.
const adminDistDir = resolve(import.meta.dirname, "../../admin/dist");
const hasAdminDist = existsSync(join(adminDistDir, "index.html"));
if (hasAdminDist) {
  app.use(
    "/assets/*",
    serveStatic({
      root: adminDistDir,
      onFound: (_path, c) => {
        // Hashed filenames -> immutable cache.
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.get("/favicon.svg", serveStatic({ root: adminDistDir }));
  app.get("/icons.svg", serveStatic({ root: adminDistDir }));
  console.log(`admin SPA: serving from ${adminDistDir}`);
} else {
  console.log("admin SPA: dist not built, skipping static serving");
}

app.notFound((c) => {
  // SPA fallback for browser navigations only. API clients (Accept:
  // application/json or text/event-stream for SSE) get a JSON 404 so a typo'd
  // endpoint doesn't silently return HTML.
  const accept = c.req.header("Accept") ?? "";
  const wantsHtml = accept.includes("text/html");
  const wantsSse = accept.includes("text/event-stream");
  if (c.req.method === "GET" && wantsHtml && !wantsSse && hasAdminDist) {
    return c.body(Bun.file(join(adminDistDir, "index.html")).stream());
  }
  return c.json({ error: "not_found" }, 404);
});
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_server_error" }, 500);
});

const port = Number(process.env.PORT ?? 3000);

try {
  await ensureIndexes(await getDb());
  console.log("mongodb ready");
} catch (err) {
  console.error("mongodb connection failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}

Bun.serve({ port, fetch: app.fetch });
console.log(`api listening on http://localhost:${port}`);

export { app };