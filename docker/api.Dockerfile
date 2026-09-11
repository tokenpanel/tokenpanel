FROM oven/bun:1.4.0-alpine

WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile || (rm -rf /root/.bun/install/cache && bun install --frozen-lockfile)

EXPOSE 3000

CMD ["bun", "run", "--cwd", "apps/api", "dev"]
