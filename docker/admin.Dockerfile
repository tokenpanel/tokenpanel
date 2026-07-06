FROM oven/bun:1.2.21-alpine

WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile || (rm -rf /root/.bun/install/cache && bun install --frozen-lockfile)

EXPOSE 5173

CMD ["bun", "run", "--cwd", "apps/admin", "dev", "--", "--host", "0.0.0.0"]
