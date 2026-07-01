# Agent Instructions

## Architecture

**TokenPanel** — admin panel + API for reselling AI services: track token
usage, customer balances, subscriptions, budgets, and rolling limits
(5-hour, weekly, etc.).

### Stack

- **Runtime / package manager:** Bun only (`bun install`, `bun run`, `bun test`). No npm/node/yarn/pnpm.
- **Monorepo:** Bun workspaces + Turborepo (`turbo.json`, `bun run build/dev/lint/typecheck`).
- **Language:** TypeScript everywhere. `tsconfig.base.json` is the shared root; each package extends it. Strict mode, no `any`, no unchecked index access, no unused locals/params.
- **Backend:** `apps/api` — Hono on `Bun.serve`, request validation via `@hono/zod-validator`.
- **Admin panel:** `apps/admin` — Vite + React 19 + TypeScript.
- **Database:** `packages/db` — raw `mongodb` Node driver (no Mongoose). Every collection has a zod schema (Doc + CreateInput). Types flow: `z.infer` → `Collection<T>` → consumers. No `any` at the db boundary.
- **Validation:** zod is the single source of truth for shapes, used both in `packages/db` (storage schemas) and `apps/api` (route validation).

### Layout

```
apps/
  api/        @tokenpanel/api     Hono backend (Bun.serve)
  admin/      @tokenpanel/admin   Vite + React admin panel
packages/
  db/         @tokenpanel/db      MongoDB driver + zod schemas
tsconfig.base.json                shared TS config
turbo.json                       task pipeline (build/dev/lint/typecheck/clean)
```

### Conventions

- Workspace package names are scoped: `@tokenpanel/{api,admin,db}`.
- Cross-package imports use `workspace:*` in `package.json` and path aliases in `tsconfig.json` (`@tokenpanel/db`).
- DB schemas live in `packages/db/src/schemas/*.ts`. Each domain exports `…Doc` (stored shape, with `_id`, `createdAt`, `updatedAt`) and `…CreateInput` (input shape, ObjectId as string → coerced). Use `getDb()` to get a `TypedDb` whose collections are already typed; never call `db.collection("string")` directly outside `packages/db`.
- Money is stored as integer minor units (`amountMinor`) + ISO currency code, never floats.
- Env: Bun auto-loads `.env`; no dotenv import. Required vars: `MONGODB_URI`, `MONGODB_DB`, optional `PORT`.
- API fail-fast: server exits if MongoDB is unreachable on boot.

### Common commands

```bash
bun install                 # install all workspaces
bun run dev                 # turbo dev (api + admin in parallel; needs local mongod)
bun run build               # turbo build (respects ^build deps)
bun run typecheck           # turbo typecheck
bun run lint                # turbo lint
bun --filter @tokenpanel/api dev    # run one workspace's dev
```

### Docker local-dev

`compose.yml` boots MongoDB 8 + api + admin with hot-reload bind-mounts. Bun
scripts wrap `docker compose`:

```bash
bun run docker:start    # build + up -d (reuses mongo volume)
bun run docker:restart  # force-recreate containers (keeps data)
bun run docker:reset    # down -v + up (WIPES mongo data, fresh DB)
bun run docker:stop     # stop containers (keep state)
bun run docker:logs     # tail logs
bun run docker:ps       # container status
# aliases: bun run start | stop | restart | reset
```

- `docker:start` requires a `.env` (copy `.env.example`). Bun auto-loads it for
  non-Docker dev; compose reads it via `--env-file .env`.
- Inside compose, api connects to `mongo` via `MONGODB_URI` built from
  `MONGO_USER`/`MONGO_PASS` (not the host `MONGODB_URI`).
- Mongo exposed on host `:27017` (`MONGO_HOST_PORT` to remap). api `:3000`,
  admin `:5173`.
- `docker:reset` is destructive: drops the `tokenpanel-mongo` volume.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

