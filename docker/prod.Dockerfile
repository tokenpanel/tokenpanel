# --- Stage 1: build admin SPA ---
FROM oven/bun:1.2.21-alpine AS admin-build

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/db/package.json packages/db/package.json
RUN bun install --frozen-lockfile

COPY packages/db packages/db
COPY apps/api apps/api
RUN bun run --filter @tokenpanel/db build

COPY apps/admin apps/admin
RUN bun run --filter @tokenpanel/admin build

# --- Stage 2: runtime (api + admin dist) ---
FROM oven/bun:1.2.21-alpine

WORKDIR /app

# Copy the same workspace package.json set as the build stage so the lockfile
# resolves identically (--frozen-lockfile requires a matching workspace set).
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/db/package.json packages/db/package.json
RUN bun install --frozen-lockfile

COPY packages/db packages/db
COPY apps/api apps/api
COPY --from=admin-build /app/apps/admin/dist apps/admin/dist

EXPOSE 3000

CMD ["bun", "run", "--cwd", "apps/api", "start"]