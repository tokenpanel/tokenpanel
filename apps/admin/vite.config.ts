import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, Vite runs on :5173 and proxies API routes to the api service, so the
// browser sees everything same-origin (no CORS). In prod, the api container
// serves the built admin SPA from apps/admin/dist, so there is only one port.
//
// Proxy target: VITE_DEV_API_URL (default http://localhost:3000 for host dev).
// In docker compose, set VITE_DEV_API_URL=http://api:3000 (service DNS).

function resolveDevApiTarget(mode: string): string {
  const env = loadEnv(mode, path.resolve(__dirname, "../.."), "");
  const raw = env.VITE_DEV_API_URL || process.env.VITE_DEV_API_URL || "http://localhost:3000";
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`VITE_DEV_API_URL must be http(s), got ${u.protocol}`);
    }
    return u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
  } catch (e) {
    throw new Error(
      `Invalid VITE_DEV_API_URL (${raw}): ${e instanceof Error ? e.message : e}`,
    );
  }
}

export default defineConfig(({ mode }) => {
  const devApiTarget = resolveDevApiTarget(mode);
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@tokenpanel/contracts": path.resolve(
          __dirname,
          "../../packages/contracts/src/index.ts",
        ),
      },
    },
    server: {
      proxy: {
        "/admin": devApiTarget,
        "/v1": devApiTarget,
        "/health": devApiTarget,
      },
    },
  };
});
