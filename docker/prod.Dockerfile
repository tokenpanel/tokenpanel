# --- Stage 1: install deps + build admin SPA ---
FROM oven/bun:1.2.21-alpine AS build

WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile || (rm -rf /root/.bun/install/cache && bun install --frozen-lockfile)
RUN bun run --filter @tokenpanel/db build
RUN bun run --filter @tokenpanel/admin build

# --- Stage 2: runtime (api + admin dist) ---
FROM oven/bun:1.2.21-alpine

WORKDIR /app
ENV NODE_ENV=production

# Copy built assets first so BuildKit cannot run the runtime install in
# parallel with the build-stage install. The runtime install is production-only,
# so lint/test-only native bindings are not fetched for the serving image.
COPY --from=build /app/apps/admin/dist apps/admin/dist
COPY . .
RUN bun install --frozen-lockfile --production || (rm -rf /root/.bun/install/cache && bun install --frozen-lockfile --production)

EXPOSE 3000

CMD ["bun", "run", "--cwd", "apps/api", "start"]
