FROM oven/bun:1.2.21-alpine

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/db/package.json packages/db/package.json
RUN bun install --frozen-lockfile

COPY packages/db packages/db
COPY apps/api apps/api

EXPOSE 3000

CMD ["bun", "run", "--cwd", "apps/api", "dev"]