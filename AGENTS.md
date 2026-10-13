# Agent Instructions

**TokenPanel**: self-hosted admin panel + API for AI usage tracking and access
control (token usage, account balances, subscriptions, budgets, rolling limits).

## Stack and layout

- **Bun only** (`bun install`, `bun run`, `bun test`). No npm/node/yarn/pnpm. Bun workspaces + Turborepo.
- **TypeScript strict** everywhere (`tsconfig.base.json`): no `any`, no unchecked index access, no unused locals/params.
- `apps/api` (`@tokenpanel/api`): Hono on `Bun.serve`; route validation via Effect Schema + `sValidator`.
- `apps/admin` (`@tokenpanel/admin`): Vite + React 19.
- `packages/db` (`@tokenpanel/db`): raw `mongodb` driver (no Mongoose), Effect Schema per collection, migrations.
- `packages/contracts` (`@tokenpanel/contracts`): browser-safe product contracts (Effect Schema).
- `packages/config` (`@tokenpanel/config`): runtime/deploy config registry, renderer, release policy.
- `manager/`: bash deployment manager (installer, `tokenpanel` CLI, templates, generated `release/`).
- Cross-package imports use `workspace:*` plus tsconfig path aliases.

## Conventions

- Effect Schema is the single source of truth for shapes: storage schemas in `packages/db`, route validation in `apps/api`.
- **Config keys** live only in `packages/config/src/fields.ts`. Never hand-edit templates, `.env.example`, manager allowlists, or preflight lists: add the field, run `bun run config:generate`, commit the regenerated `manager/release/` files with the change.
- **Contracts**: no env, I/O, Node, Mongo, or UI. Admin may import contracts, never `@tokenpanel/db`. Migrations use frozen snapshots, never live contracts.
- **DB access**: schemas in `packages/db/src/schemas/*.ts` export `…Doc` (with `_id`, `createdAt`, `updatedAt`) and `…CreateInput` (ObjectIds as strings, coerced). Use the typed `getDb()`; never `db.collection("…")` outside `packages/db`. Executables call `configureDb({ uri, databaseName })` first.
- **Money**: integer micros (`amountMicros`, 10⁻⁶ major unit) + ISO currency code, never floats. Admin enters major units; `packages/contracts/src/money-micros.ts` converts at the boundary.
- **Env**: Bun auto-loads `.env` in dev (no dotenv). The API parses config once (`parseApiRuntimeConfig`, `apps/api/src/config/runtime.ts`) and exits if config is invalid or MongoDB is unreachable.

## Migrations

Timestamped files in `packages/db/migrations/{pre,post}/`, created with
`bun run --filter @tokenpanel/db db:new-migration`.

- `pre/`: additive only. Runs from the new image while the old version still serves, and on every API boot. SafeMigrate lint rejects `drop`, `$unset`, `$rename`, `collMod`, `dropIndex` in `pre/` `up()`.
- `post/`: destructive allowed. The manager runs it with the API stopped, after a backup, before starting the new container. Never runs on API boot.
- Each migration runs in a transaction (replica set) unless `transactional = false`. Applied ids and file SHA-256 are tracked in `_migrations`; `_migration_lock` serializes runners.
- **Immutable once pushed (hard rule):** never edit, reformat, rename, or delete a committed migration, including comments and whitespace. Any byte change fails boot with "already applied with a different checksum". Fix forward with a new migration. Rewriting is acceptable only if the file was never pushed or applied to a shared DB. Dev-only recovery: restore the file, update the matching `_migrations.checksum` after confirming the schema already matches, or `bun run docker:reset`. Never change checksums in production.
- Dev commands (from `packages/db`): `bun run db:migrate -- --phase=pre|post`, `bun run db:status`. Production uses only the manager.
- Schema change: edit schemas → `bun run schema:check` → add a migration if drift → `bun run schema:snapshot` and commit `packages/db/generated/schema-snapshot.json` with it.

## Local development

- `bun run docker:start` (needs `.env` copied from `.env.example`) boots `compose.yml`: MongoDB 8 single-node replica set `rs0`, api `:3000`, admin `:5173`, hot reload. Also `docker:stop|restart|logs|ps`; `docker:reset` wipes the mongo volume.
- **Compose MongoDB only (hard rule):** the running app, including `bun run dev`, uses the compose MongoDB on host `:27017` (`MONGO_HOST_PORT` to remap). Never start or use a host/global `mongod`; if one holds `:27017`, stop it or remap.
- **Tests never touch compose MongoDB:** integration tests use `startTestDb`/`stopTestDb` from `@tokenpanel/db/test-support/memory-server` (isolated replica set, unique `databaseName` per suite; `TEST_MONGODB_URI` is an opt-in debug escape hatch). Do not gate tests on environment probes.
- Checks: `bun run test` (includes manager tests), `bun run typecheck`, `bun run lint`, `bun run build`. `bun run e2e` runs Playwright against an isolated `compose.e2e.yml` stack.

## Production and the manager

- Production is installed only via `manager/install.sh` and updated only via `tokenpanel update`. Never document or add manual production paths (`git pull`, `docker compose` from a clone, hand-run migrations, a production compose profile). Root `compose.yml` is dev-only.
- Only `tokenpanel update` changes the deployed version: `rebuild` and `tokenpanel-setup` refuse a checkout that differs from the deployed image (`--force` to override), and the installer exits on a live install.
- The manager is bash only (no Bun/Node on the host). Images are built on the host from the `/opt/tokenpanel` checkout.
- Operators edit only `/etc/tokenpanel/tokenpanel.yml`. The manager renders `/etc/tokenpanel/generated/` from the target release (legacy `.env` is auto-migrated), snapshots config in `/etc/tokenpanel/snapshots/`, and keeps data in `/var/tokenpanel/shared/`.
- Update flow (`cmd_update`, `manager/bin/tokenpanel`): load target manager → build → render config → `pre/` (old still serving) → stop api → backup → `post/` → start + health check. Failure restores the backup, previous image, and config snapshot.

### Upgrade compatibility (hard rule)

- Every update is a cross-version protocol. Until swap completes, the running API, image, database shape, generated config, and manager state may come from any supported older release.
- Pre-swap work (preflight, backup restart, pre-migrations, health checks, rollback, recovery) must not depend on endpoints, commands, env keys, files, schema semantics, or manager helpers introduced only by the target release. Refresh to the target manager before compatibility-sensitive work; probe old images through a frozen legacy contract or explicit capability detection; keep strict target-only checks for the new image after swap.
- Keep old readers and writers valid through additive pre-migrations. New config/template requirements need backward-compatible defaults.
- The manager at the tip of `main` is a permanent trampoline: managers that predate release tags check out `origin/main` and run its `tokenpanel update` with `TOKENPANEL_UPDATE_BOOTSTRAPPED=1`, `TOKENPANEL_UPDATE_LOCK_FD`, `TOKENPANEL_UPDATE_FROM_VERSION` and no target. `main` must keep accepting that call and handing off to the latest stable tag. Never remove or rename those env keys.
- The deployed version is the image's `org.opencontainers.image.revision` label (legacy images: their `git describe` tag), never the checkout, which a failed update or rollback leaves on the target.
- Test upgrade paths, not only clean installs: N-1 and oldest supported release to current, backup restart, failed-swap rollback, missing new capabilities (404, unknown command, missing env), and retry after each phase fails. A fix available only after the failing phase is not a fix.

## Releases

- A release is a tag `vX.Y.Z` on `main` (prereleases `vX.Y.Z-rc.N`). Merge `dev` into `main` with a merge commit (not squash), preview with `bun run release:notes`, then `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`. `.github/workflows/release.yml` publishes the GitHub Release with git-cliff notes (`cliff.toml`).
- `tokenpanel update` installs the highest stable tag reachable from `origin/main` (`manager/lib/release.sh`); before the first tag it uses `origin/main`.
- Never move or delete a published tag (older managers fail their fetch). Never create a `stable` branch (managers from before July 2026 pull it).
- Before pushing: `bun run release:check` (generated config fragments, config policy, schema snapshot). CI runs it with typecheck, lint, and tests.
- Config policy: new required keys need a default or start optional; removing a key needs `deprecatedSince` in a prior release; kind or secret-flag changes are breaking; default/validation changes warn.

## Shell

Use non-interactive forms, since aliases may add `-i`: `cp -f`, `mv -f`, `rm -f`, `rm -rf`, `cp -rf`; `ssh`/`scp -o BatchMode=yes`; `apt-get -y`.
