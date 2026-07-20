/**
 * API executable entry (section 10.9).
 *
 * Order: bootApi (config → mongo → pre migrations → ManagedRuntime) →
 * compose Hono → Bun.serve → WorkerControl.start → register shutdown.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { ConfigValidationError } from "./config/runtime.ts";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_CHAT_REQUEST_BODY_BYTES,
} from "./config/security-policy.ts";
import { resolveMongo } from "./infrastructure/mongo/resolve-db.ts";
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
import managementKeyRoutes from "./routes/management-keys.ts";
import managementRead from "./routes/management/read.ts";
import managementWrite from "./routes/management/write.ts";
import dashboardRoutes from "./routes/dashboard.ts";
import analyticsSummaryRoutes from "./routes/analytics-summary.ts";
import publicOpenAI from "./routes/public/openai.ts";
import publicAnthropic from "./routes/public/anthropic.ts";
import { requirePublicPrincipal } from "./middleware/public-auth.ts";
import { requireManagementPrincipal } from "./middleware/management-auth.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import "./providers/index.ts";
import {
  bootApi,
  registerShutdownSignals,
  shutdownApi,
  BootError,
} from "./runtime/boot.ts";
import { WorkerControl } from "./runtime/services/worker-control.ts";

const boot = await (async () => {
  try {
    return await bootApi({
      registerSignals: true,
      installRuntime: true,
      applyProcessGlobals: true,
      runPreMigrations: true,
    });
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      for (const issue of err.issues) {
        console.error(`config: ${issue.variable}: ${issue.reason}`);
      }
    } else if (err instanceof BootError) {
      console.error(`boot[${err.phase}]: ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
})();

const { config: runtimeConfig, runtime, mongo } = boot;

const app = new Hono<{ Variables: AuthVariables }>();

// Direct-deployment headers (Caddy also sets overlapping ones at the edge).
app.use("*", securityHeaders);

// Hard cap request bodies before any JSON parse / Effect Schema decode.
// Chat (/v1, playground) may carry base64 media → higher cap; admin/management
// stay on the tighter default. Applied as one middleware so limits do not stack
// (a global 1 MiB would reject chat before a route-level 10 MiB ran).
const bodyTooLarge = (c: { json: (b: unknown, s: 413) => Response }) =>
  c.json({ error: "payload_too_large", message: "Request body too large" }, 413);

app.use("*", async (c, next) => {
  const path = c.req.path;
  const isChatSurface =
    path.startsWith("/v1/") || path.startsWith("/admin/playground/");
  const maxSize = isChatSurface
    ? MAX_CHAT_REQUEST_BODY_BYTES
    : MAX_REQUEST_BODY_BYTES;
  const limit = bodyLimit({ maxSize, onError: bodyTooLarge });
  return limit(c, next);
});

// Admin panel (apps/admin) and API (apps/api) run on separate origins in dev.
// Auth is JWT Bearer (no cookies), so reflecting Origin is safe.
const allowedOrigins = runtimeConfig.corsOrigins;
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      if (allowedOrigins === null) return origin;
      return allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 600,
  }),
);

// Legacy combined health (kept for existing probes). Prefer /live + /ready.
app.get("/health", (c) => c.json({ status: "ok" }));

/** Process liveness only — no dependency checks. */
app.get("/live", (c) => c.json({ status: "live" }));

/** Readiness: bounded Mongo ping. Used for rollout / compose health. */
app.get("/ready", async (c) => {
  try {
    const { rawDb } = await resolveMongo();
    await rawDb.command({ ping: 1 });
    return c.json({ status: "ready" });
  } catch {
    return c.json(
      { status: "not_ready", reason: "dependency_unavailable" },
      503,
    );
  }
});

app.route("/admin/auth", authRoutes);
app.route("/admin/auth", signupRoutes);
app.route("/admin/auth", acceptInviteRoute);
app.route("/admin/customers", customers);
app.route("/admin/dashboard", dashboardRoutes);
app.route("/admin/analytics", analyticsSummaryRoutes);
app.route("/admin/providers", providers);
app.route("/admin/models", models);
app.route("/admin/plans", plans);
app.route("/admin/api-keys", apiKeys);
app.route("/admin/invites", inviteRoutes);
app.route("/admin/organizations", organizationRoutes);
app.route("/admin/playground", playgroundRoutes);
app.route("/admin/catalog-sources", catalogSourceRoutes);
app.route("/admin/management-keys", managementKeyRoutes);

// Public /v1 auth once — both OpenAI and Anthropic routers share this.
app.use("/v1/*", requirePublicPrincipal);
app.route("/", publicOpenAI);
app.route("/", publicAnthropic);

// Management server-to-server surface.
app.use("/api/management/*", requirePublicPrincipal);
app.use("/api/management/*", requireManagementPrincipal);
app.route("/", managementRead);
app.route("/", managementWrite);

// --- Static admin SPA ---
const adminDistDir = resolve(import.meta.dirname, "../../admin/dist");
const hasAdminDist = existsSync(join(adminDistDir, "index.html"));
if (hasAdminDist) {
  app.use(
    "/assets/*",
    serveStatic({
      root: adminDistDir,
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.get("/logo.png", serveStatic({ root: adminDistDir }));
  app.get("/icons.svg", serveStatic({ root: adminDistDir }));
  console.log(`admin SPA: serving from ${adminDistDir}`);
} else {
  console.log("admin SPA: dist not built, skipping static serving");
}

app.notFound((c) => {
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

const port = runtimeConfig.port;

console.log("mongodb ready");
// Pass Bun server into Hono env so getConnInfo / client-IP can use requestIP.
Bun.serve({
  port,
  fetch(req, server) {
    return app.fetch(req, { server });
  },
});
console.log(`api listening on http://localhost:${port}`);

// Start settlement reconcile worker via WorkerControl (task 10.9).
await runtime.runPromise(
  Effect.gen(function* () {
    const workers = yield* WorkerControl;
    yield* workers.start();
  }),
);

// Ensure signals registered (bootApi may have done this).
registerShutdownSignals(runtimeConfig);

void mongo;
void shutdownApi;

export { app, runtime, runtimeConfig };
