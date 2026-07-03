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
- **Migrations**: ordered, timestamped migration files in `packages/db/migrations/{pre,post}/`.
  `pre/` runs before `Bun.serve` (additive only); `post/` runs after deploy (destructive allowed,
  gated by `RUN_POST_MIGRATIONS=1`). SafeMigrate lint rejects destructive ops (`drop`, `$unset`,
  `$rename`, `collMod`, `dropIndex`) in `pre/` `up()` functions. Each migration runs in a
  transaction (replica set required). Tracked in `_migrations` collection with checksum.
  Lock via `_migration_lock` (TTL 5 min, renewed by a 60 s heartbeat while a
  migration runs; dead holders still auto-expire). Commands: `bun run db:new-migration`,
  `bun run db:migrate`, `bun run db:status` (run from `packages/db`).

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

`compose.yml` boots MongoDB 8 (single-node replica set) + api + admin with
hot-reload bind-mounts. Bun scripts wrap `docker compose`:

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
  `MONGO_USER`/`MONGO_PASS` with `directConnection=true` (not the host `MONGODB_URI`).
- MongoDB runs as a **single-node replica set** (`rs0`). A `mongo-init` one-shot
  container initiates the RS on first boot (idempotent). This enables multi-document
  ACID transactions (required by the migration runner).
- A keyfile is auto-generated on first boot (stored in the mongo data volume) for
  internal RS authentication.
- Mongo exposed on host `:27017` (`MONGO_HOST_PORT` to remap). api `:3000`,
  admin `:5173`.
- `docker:reset` is destructive: drops the `tokenpanel-mongo` volume.
- For non-Docker dev (`bun run dev`), start local mongod with `--replSet rs0`
  and initiate it (`mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'`)
  to enable transaction support.

### Deployment Manager

`manager/` contains the deployment system (bash scripts + templates, modeled
after Discourse's `discourse_docker`). Installed to `/opt/tokenpanel` via curl
installer. All scripts are bash (no node/bun dependency for the manager itself).

- `manager/bin/tokenpanel` — operator CLI (status, start, stop, update, backup, etc.)
- `manager/bin/tokenpanel-setup` — interactive installer wizard
- `manager/lib/*.sh` — shared library (config, output, preflight, health, backup, etc.)
- `manager/templates/*.tmpl` — parameterized compose/Caddyfile/systemd templates
- Config: `/etc/tokenpanel/` (app.yml + .env), Data: `/var/tokenpanel/shared/`
- Build on host (git clone + docker build) for future plugin support.

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

