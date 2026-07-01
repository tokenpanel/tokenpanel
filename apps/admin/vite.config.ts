import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, Vite runs on :5173 and proxies API routes to the api service, so the
// browser sees everything same-origin (no CORS). In prod, the api container
// serves the built admin SPA from apps/admin/dist, so there is only one port.
//
// Proxy target: VITE_DEV_API_URL (default http://localhost:3000 for host dev).
// In docker compose, set VITE_DEV_API_URL=http://api:3000 (service DNS).
const devApiTarget = process.env.VITE_DEV_API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/admin": devApiTarget,
      "/v1": devApiTarget,
      "/health": devApiTarget,
    },
  },
});
