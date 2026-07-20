# Agent Instructions

## Architecture

**TokenPanel** — admin panel + API for AI usage tracking and access control:
track token usage, account balances, subscriptions, budgets, and rolling
limits (5-hour, weekly, etc.).

### Stack

- **Runtime / package manager:** Bun only (`bun install`, `bun run`, `bun test`). No npm/node/yarn/pnpm.
- **Monorepo:** Bun workspaces + Turborepo (`turbo.json`, `bun run build/dev/lint/typecheck`).
- **Language:** TypeScript everywhere. `tsconfig.base.json` is the shared root; each package extends it. Strict mode, no `any`, no unchecked index access, no unused locals/params.
- **Backend:** `apps/api` — Hono on `Bun.serve`, request validation via Effect Schema + `sValidator` (Effect Schema Hono validator).
- **Admin panel:** `apps/admin` — Vite + React 19 + TypeScript.
- **Database:** `packages/db` — raw `mongodb` Node driver (no Mongoose). Every collection has an Effect Schema (Doc + CreateInput). Types flow: `Schema.Schema.Type` → `Collection<T>` → consumers. No `any` at the db boundary.
- **Validation:** Effect Schema is the single source of truth for shapes, used both in `packages/db` (storage schemas) and `apps/api` (route validation via `sValidator`).

### Layout

```
apps/
  api/        @tokenpanel/api     Hono backend (Bun.serve)
  admin/      @tokenpanel/admin   Vite + React admin panel
packages/
  contracts/  @tokenpanel/contracts  Browser-safe shared product contracts (Effect Schema)
  config/     @tokenpanel/config  Runtime/deploy config registry, renderer, release policy
  db/         @tokenpanel/db      MongoDB driver + Effect Schema schemas
manager/
  release/                        generated release manifest + bash-safe config fragments
tsconfig.base.json                shared TS config
turbo.json                       task pipeline (build/dev/lint/typecheck/clean)
```

### Conventions

- Workspace package names are scoped: `@tokenpanel/{api,admin,db,contracts,config}`.
- Cross-package imports use `workspace:*` in `package.json` and path aliases in `tsconfig.json` (`@tokenpanel/db`, `@tokenpanel/contracts`, `@tokenpanel/config`).
- **`@tokenpanel/config`** is the single source of truth for runtime/deploy config keys (`packages/config/src/fields.ts`). Never add env vars or operator settings manually to templates, `.env.example`, manager allowlists, or preflight lists. Add the field definition, then run `bun run config:generate`. Generated files under `manager/release/` must be committed.
- **`@tokenpanel/contracts`**: pure TypeScript/Effect Schema product contracts (model modality/status/metadata policy, management scopes). No env, I/O, Node, Mongo, or UI. Admin may import it; never import `@tokenpanel/db` into admin. Migrations must not import live contracts (keep frozen snapshots).
- DB schemas live in `packages/db/src/schemas/*.ts`. Each domain exports `…Doc` (stored shape, with `_id`, `createdAt`, `updatedAt`) and `…CreateInput` (input shape, ObjectId as string → coerced). Use `getDb()` to get a `TypedDb` whose collections are already typed; never call `db.collection("string")` directly outside `packages/db`. Call `configureDb({ uri, databaseName })` before `getDb()` from executables (API boot, migrator CLI).
- Money is stored as integer units (`amountUnits`) + ISO currency code, never floats.
- Env/config: Bun auto-loads `.env` for local dev; no dotenv import. API parses once via `parseApiRuntimeConfig` (`apps/api/src/config/runtime.ts`). Production deployments use operator config `/etc/tokenpanel/tokenpanel.yml`; `tokenpanel-setup` and `tokenpanel update` render `/etc/tokenpanel/generated/{compose.yml,.env,manager.env,Caddyfile,release.json}` from the target release. Legacy `/etc/tokenpanel/.env` is auto-migrated to `tokenpanel.yml`. Required API config still includes `JWT_SECRET` and a MongoDB URI (generated from `database.*` unless overridden).
- API fail-fast: server exits if config invalid or MongoDB is unreachable on boot.
- **Migrations**: ordered, timestamped migration files in `packages/db/migrations/{pre,post}/`.
  Discourse-style deploy flow (manager `tokenpanel update`):
  1. **pre/** from the *new* image (old container still serving) — additive only
  2. **swap** to the new container
  3. **post/** from the *live* new container — destructive allowed (data rewrites,
     dropIndex, etc.)
  API boot runs **pre only** (so a restart never re-runs destructive post work).
  Applied migrations are tracked in `_migrations` (`_id` = migration id + checksum);
  re-runs skip already-applied files and abort if a file was edited after apply.
  SafeMigrate lint rejects destructive ops (`drop`, `$unset`, `$rename`, `collMod`,
  `dropIndex`) in `pre/` `up()` functions. Each migration runs in a transaction
  (replica set required) unless `transactional = false`. Lock via `_migration_lock`
  (TTL 5 min, 60 s heartbeat). Commands: `bun run db:new-migration`,
  `bun run db:migrate -- --phase=pre|post`, `bun run db:status` (from `packages/db`);
  operator: `tokenpanel migrate pre|post`, `tokenpanel update`.

  **IMMUTABLE once created and pushed (hard rule):**
  - Never edit, reformat, rename, or delete any file under
    `packages/db/migrations/pre/` or `packages/db/migrations/post/` after it has
    been committed/pushed. That includes comments, whitespace, `transactional`,
    and `up`/`down` bodies. SHA-256 of the whole file is stored on apply; any
    byte change fails boot with "already applied with a different checksum".
  - Need a fix or follow-up schema change? Create a **new** migration with a
    newer timestamp (`bun run db:new-migration`). Do not amend the old file.
  - Bug found before first push/apply anywhere: rewrite is OK only if the file
    was never applied to any shared/dev DB that teammates keep. Prefer new
    migration if unsure.
  - Local recovery after accidental edit: either restore original file contents,
    or (dev only, after confirming schema effects already match) update the
    matching `_migrations.checksum` to the current file SHA-256, or
    `bun run docker:reset` to wipe and re-apply. Never "fix" checksums in
    production — ship a new migration instead.

### Common commands

```bash
bun install                 # install all workspaces
bun run dev                 # turbo dev (api + admin in parallel; needs local mongod)
bun run build               # turbo build (respects ^build deps)
bun run typecheck           # turbo typecheck
bun run lint                # turbo lint
bun run config:generate     # regenerate manager/release manifest fragments
bun run release:check       # config manifest + policy + DB schema snapshot checks
bun run schema:snapshot     # refresh DB schema snapshot after intentional schema changes
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

- `manager/bin/tokenpanel` — operator CLI (status, start, stop, update, config, backup, etc.)
- `manager/bin/tokenpanel-setup` — interactive installer wizard
- `manager/lib/*.sh` — shared library (config, output, preflight, health, backup, config_render, etc.)
- `manager/templates/*.tmpl` — parameterized compose/Caddyfile/systemd templates
- `manager/release/` — generated release manifest (`manifest.json`) and bash-safe fragments (`manifest.env`, `defaults.env`, `allowed-env-keys.txt`)
- Operator config: `/etc/tokenpanel/tokenpanel.yml`; generated deployment config: `/etc/tokenpanel/generated/`; snapshots: `/etc/tokenpanel/snapshots/`; data: `/var/tokenpanel/shared/`
- `tokenpanel update` reconciles config from the target image before pre-migrations/swap: migrate legacy `.env` if needed, snapshot current config, render target templates, then use the generated compose. Rollback restores the previous config snapshot and image.
- Build on host (git clone + docker build) for future plugin support.

### Upgrade Compatibility (Hard Rule)

- Treat every update as a cross-version protocol. Until swap completes, the
  running API, image, database shape, generated Compose/config, and manager
  state may come from any supported older release.
- Never make pre-swap work (preflight, backup restart, pre-migrations, health
  checks, rollback, or recovery) depend on endpoints, commands, env keys,
  files, schema semantics, or manager helpers introduced only by the target
  release.
- Refresh and re-run the target manager before compatibility-sensitive update
  work. Probe current/rollback images through a frozen legacy contract or
  explicit capability detection; reserve strict target-only checks for the new
  image after swap.
- Keep old readers and writers valid throughout additive pre-migrations. New
  config/template requirements need backward-compatible defaults until old
  generated installations are explicitly upgraded.
- Test upgrade paths, not only clean installs: at minimum N-1 and oldest
  supported release to current, including backup restart, failed-swap rollback,
  missing new capabilities (404/unknown command/missing env), and retry after
  each phase fails. A fix available only after the failing phase is not a fix.

## Development Process (Automated Release Safety)

Manual release steps fail. Prefer generated artifacts and policy checks.

### Adding or changing config

1. Edit `packages/config/src/fields.ts`.
2. Run `bun run config:generate`.
3. Commit the code change and the regenerated `manager/release/` files together.
4. Run `bun run config:policy` (CI also runs it against `origin/main`).

Policy rules enforced by `@tokenpanel/config`:
- New required config must have a default or be introduced as optional first.
- Removing a config key requires `deprecatedSince` in a prior release.
- Changing kind or secret flag is treated as a breaking change.
- Default/validation changes produce warnings because existing installs may break.

### Adding or changing DB schemas

1. Change Effect Schemas under `packages/db/src/schemas/`.
2. Run `bun run schema:check`. If drift is detected, create the needed migration:
   `bun run --filter @tokenpanel/db db:new-migration`.
3. Run `bun run schema:snapshot` and commit the updated
   `packages/db/generated/schema-snapshot.json` with the schema/migration change.

### Release readiness

Run `bun run release:check` before pushing. It verifies:
- generated config manifest fragments are up to date
- config policy passes
- DB schema snapshot is up to date

CI runs typecheck, lint, unit tests, manager tests, and release checks on every commit/PR.

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
