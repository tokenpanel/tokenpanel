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
# There is no RUN_POST_MIGRATIONS env gate: post always runs after the api is
# healthy on every bring-up path that is supposed to leave a fully-migrated
# schema. Call sites (all idempotent via `_migrations`):
#   - tokenpanel update        Phase 6 (after swap)
#   - tokenpanel start         after health
#   - tokenpanel rebuild       after force-recreate + health
#   - tokenpanel-setup         after first-start health
#   - systemd ExecStart        → tokenpanel start (not raw compose)
# A release with no pending post files simply reports 0 applied / N skipped.
# API process boot runs pre/ only — never post/ (restarts must not re-run
# destructive work).
#
# Two entry points:
#   run_migrations <phase>
#       spawn a named one-shot container from the image currently selected by
#       Compose. Used for post-deploy migrations (all call sites above) and
#       standalone `tokenpanel migrate`; this makes cancellation targetable.
#   run_migrations_image <phase> <image_tag>
#       spawn a one-shot container from a *specific* pre-built image
#       (tokenpanel/app:<tag>) on the same compose network/env, without
#       touching the running container. Used for pre-deploy migrations
#       (Phase 4): the new image contains the new migration files; the old
#       container keeps serving while they apply.

migration_timeout_seconds() {
  case "$1" in
    pre) printf '%s\n' 1800 ;;
    post) printf '%s\n' 600 ;;
    *) return 1 ;;
  esac
}

validate_migration_phase() {
  case "$1" in
    pre|post) return 0 ;;
    *)
      err "invalid migration phase: '$1' (expected pre or post)"
      return 1
      ;;
  esac
}

# Run migration in a named one-shot container and wait on that container, not
# on a Compose client process. `timeout docker compose exec ...` can kill only
# the local client while leaving the database migrator alive. On every exit
# path (including TERM from systemd), the EXIT trap force-removes this worker;
# Bun then loses its DB connection and Mongo rolls back its active transaction.
run_migration_worker() (
  local phase="$1"
  local image_tag="${2:-}"
  local override=""
  local timeout_s
  timeout_s="$(migration_timeout_seconds "$phase")" || return 1

  local migration_container
  migration_container="tokenpanel-migrate-${phase}-$$-${RANDOM}"
  trap 'docker rm -f -- "$migration_container" >/dev/null 2>&1 || true; [ -z "$override" ] || rm -f -- "$override"' EXIT

  local -a compose_args
  compose_args=(compose -f "$APP_YML")
  if [ -n "$image_tag" ]; then
    override="$(mktemp "${TMPDIR:-/tmp}/tokenpanel-migrate-override.XXXXXX.yml" 2>/dev/null || mktemp)" || {
      err "could not create temp override file"
      return 1
    }
    printf 'services:\n  api:\n    image: "tokenpanel/app:%s"\n' "$image_tag" >"$override"
    compose_args+=(-f "$override")
  fi

  local migrate_cmd="bun run --cwd /app/packages/db db:migrate -- --phase=${phase}"
  if ! docker "${compose_args[@]}" run -d --no-deps --name "$migration_container" \
    --entrypoint sh api -c "$migrate_cmd" </dev/null >/dev/null; then
    err "could not start ${phase}/ migration worker"
    return 1
  fi

  local wait_rc=0
  timeout --kill-after=5s "${timeout_s}s" docker wait "$migration_container" >/dev/null || wait_rc=$?
  if [ "$wait_rc" -ne 0 ]; then
    # The EXIT trap removes the container. This explicit removal makes timeout
    # cancellation synchronous before returning control to deployment logic.
    docker rm -f -- "$migration_container" >/dev/null 2>&1 || true
    if [ "$wait_rc" -eq 124 ] || [ "$wait_rc" -eq 137 ] || [ "$wait_rc" -eq 143 ]; then
      err "${phase}/ migration timed out after ${timeout_s}s; worker cancelled"
    else
      err "could not wait for ${phase}/ migration worker"
    fi
    return 1
  fi

  local exit_code
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$migration_container" 2>/dev/null)" || {
    err "could not inspect ${phase}/ migration worker result"
    return 1
  }
  if ! [[ "$exit_code" =~ ^[0-9]+$ ]] || [ "$exit_code" -ne 0 ]; then
    err "${phase}/ migration failed${exit_code:+ (exit ${exit_code})}"
    return 1
  fi
)

run_migrations() {
  local phase="${1:-pre}"
  validate_migration_phase "$phase" || return 1
  local timeout_s
  timeout_s="$(migration_timeout_seconds "$phase")" || return 1
  info "running ${phase}/ migrations (one-shot worker, max ${timeout_s}s)..."
  run_migration_worker "$phase"
}

# Run <phase> migrations from a pre-built image in a one-shot container.
# A throwaway compose override pins `api.image` to the requested tag so the
# NEW image (with new migration files) is used; the base service's
# env_file/environment/network are inherited, so MONGODB_URI + mongo host
# match the live api. --no-deps keeps mongo (and the old container) untouched.
run_migrations_image() {
  local phase="${1:-pre}"
  local image_tag="${2:-}"

  validate_migration_phase "$phase" || return 1

  if [ -z "$image_tag" ]; then
    err "run_migrations_image: image tag required"
    return 1
  fi

  if ! [[ "$image_tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
    err "run_migrations_image: invalid image tag"
    return 1
  fi

  if ! docker image inspect "tokenpanel/app:${image_tag}" >/dev/null 2>&1; then
    err "image not found: tokenpanel/app:${image_tag} — did the build phase run?"
    return 1
  fi

  local timeout_s
  timeout_s="$(migration_timeout_seconds "$phase")" || return 1
  info "running ${phase}/ migrations from tokenpanel/app:${image_tag} (one-shot, max ${timeout_s}s)..."
  run_migration_worker "$phase" "$image_tag"
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
