#!/usr/bin/env bash
# Unit test: migration workers are named, inspected, and removed on success,
# failure, and wait timeout. This prevents a timed-out Compose client from
# leaving a migrator process active against MongoDB.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
LOG="$TMP/docker.log"
trap 'rm -rf "$TMP"' EXIT

APP_YML="$TMP/app.yml"
touch "$APP_YML"

# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"

docker() {
  printf '%s\n' "$*" >>"$LOG"
  case "${1:-}" in
    image) return 0 ;;
    compose)
      shift
      while [ "${1:-}" = "-f" ]; do shift 2; done
      [ "${1:-}" = "run" ] && return 0
      return 1
      ;;
    wait) return "${MIGRATE_WAIT_RC:-0}" ;;
    inspect) printf '%s\n' "${MIGRATE_EXIT_CODE:-0}"; return 0 ;;
    rm) return 0 ;;
    *) return 1 ;;
  esac
}

# Exercise wait result handling without a real 10/30-minute delay.
timeout() {
  while [[ "${1:-}" == --kill-after=* || "${1:-}" == *s ]]; do shift; done
  "$@"
}

# shellcheck source=../migrate.sh
source "$ROOT/manager/lib/migrate.sh"

fail() { echo "FAIL: $*"; exit 1; }

# --- success: starts detached worker, waits, inspects, removes ---
: >"$LOG"
MIGRATE_WAIT_RC=0 MIGRATE_EXIT_CODE=0 run_migrations post || fail "successful worker failed"
grep -q 'run -d --no-deps --name tokenpanel-migrate-post-' "$LOG" || fail "worker was not started detached and named"
grep -q 'wait tokenpanel-migrate-post-' "$LOG" || fail "worker was not waited"
grep -q 'inspect --format {{.State.ExitCode}} tokenpanel-migrate-post-' "$LOG" || fail "worker exit code was not inspected"
grep -q 'rm -f -- tokenpanel-migrate-post-' "$LOG" || fail "worker was not cleaned up"
echo "OK: successful worker is cleaned up"

# --- timeout/failure: force removal happens before control returns ---
: >"$LOG"
set +e
MIGRATE_WAIT_RC=124 MIGRATE_EXIT_CODE=0 run_migrations pre
rc=$?
set -e
[ "$rc" -eq 1 ] || fail "timed-out worker returned $rc, expected 1"
grep -q 'rm -f -- tokenpanel-migrate-pre-' "$LOG" || fail "timed-out worker was not cancelled"
echo "OK: timed-out worker is cancelled"

# --- input validation: no arbitrary phase/image reaches Compose ---
: >"$LOG"
set +e
run_migrations 'post; touch /tmp/unsafe'
phase_rc=$?
run_migrations_image pre 'bad"tag'
tag_rc=$?
set -e
[ "$phase_rc" -eq 1 ] || fail "invalid phase accepted"
[ "$tag_rc" -eq 1 ] || fail "invalid image tag accepted"
[ ! -s "$LOG" ] || fail "invalid migration input reached docker"
echo "OK: migration inputs validated"

echo "ALL PASS"
