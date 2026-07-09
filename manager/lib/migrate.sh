#!/usr/bin/env bash
# Migration runner wrapper — calls the app's migrator CLI.
#
# Discourse-style update (tokenpanel update):
#   Phase 4 → run_migrations_image pre  <new_tag>   (old container still serving)
#   Phase 5 → swap containers
#   Phase 6 → run_migrations post                     (live new container)
#
# Tracking: packages/db migrator writes each applied id+checksum into the
# `_migrations` collection. Re-running pre or post is safe — already-applied
# files are skipped; edited-after-apply files abort with a checksum error.
# There is no RUN_POST_MIGRATIONS env gate: post always runs in Phase 6 / on
# start; a release with no pending post files simply reports 0 applied.
#
# Two entry points:
#   run_migrations <phase>
#       exec into the currently-running api container. Used for post-deploy
#       migrations (Phase 6, after the swap), first-start post apply, and the
#       standalone `tokenpanel migrate` command — in all cases the live
#       container already runs the image whose migration files we want.
#   run_migrations_image <phase> <image_tag>
#       spawn a one-shot container from a *specific* pre-built image
#       (tokenpanel/app:<tag>) on the same compose network/env, without
#       touching the running container. Used for pre-deploy migrations
#       (Phase 4): the new image contains the new migration files; the old
#       container keeps serving while they apply.

run_migrations() {
  local phase="${1:-pre}"
  info "running ${phase}/ migrations (live container)..."
  # phase is always "pre" or "post" (call-site controlled).
  docker compose -f "$APP_YML" exec -T api \
    bun run --cwd /app/packages/db db:migrate -- --phase="$phase" || {
    err "${phase}/ migration failed"
    return 1
  }
}

# Run <phase> migrations from a pre-built image in a one-shot container.
# A throwaway compose override pins `api.image` to the requested tag so the
# NEW image (with new migration files) is used; the base service's
# env_file/environment/network are inherited, so MONGODB_URI + mongo host
# match the live api. --no-deps keeps mongo (and the old container) untouched.
run_migrations_image() {
  local phase="${1:-pre}"
  local image_tag="${2:-}"

  if [ -z "$image_tag" ]; then
    err "run_migrations_image: image tag required"
    return 1
  fi

  if ! docker image inspect "tokenpanel/app:${image_tag}" >/dev/null 2>&1; then
    err "image not found: tokenpanel/app:${image_tag} — did the build phase run?"
    return 1
  fi

  local override
  override="$(mktemp "${TMPDIR:-/tmp}/tokenpanel-migrate-override.XXXXXX.yml" 2>/dev/null || mktemp)" || {
    err "could not create temp override file"
    return 1
  }

  # Override ONLY the api service image. The base app.yml still provides
  # env_file, environment (MONGODB_URI etc.), and network — none of which we
  # want to reconstruct by hand. Tag comes from `git describe` (no quotes/colons
  # that break YAML), but quote it defensively anyway.
  cat >"$override" <<YAML
services:
  api:
    image: "tokenpanel/app:${image_tag}"
YAML

  # Migrator invocation (api service workdir = /app). phase is call-site
  # controlled ("pre"|"post"), so interpolation into sh -c is safe.
  local migrate_cmd="bun run --cwd /app/packages/db db:migrate -- --phase=${phase}"

  info "running ${phase}/ migrations from tokenpanel/app:${image_tag} (one-shot)..."
  local rc=0
  # </dev/null guarantees non-interactive (no TTY allocation / stdin hang) inside
  # the update script.
  docker compose -f "$APP_YML" -f "$override" run --rm --no-deps \
    --entrypoint sh api -c "$migrate_cmd" </dev/null || rc=$?

  rm -f "$override"

  if [ "$rc" -ne 0 ]; then
    err "${phase}/ migration failed (image tokenpanel/app:${image_tag})"
    return 1
  fi
}

# Show migration status. Previously this swallowed ALL errors with
# `2>/dev/null || true`, hiding invalid migration files (syntax/lint failures
# from `bun run db:status`) as empty output. Now stderr is surfaced and the
# real exit code is returned so callers (cmd_status, doctor) can warn loudly.
# Callers that must tolerate an offline api wrap this in a graceful guard.
migration_status() {
  docker compose -f "$APP_YML" exec -T api \
    bun run --cwd /app/packages/db db:status
}
