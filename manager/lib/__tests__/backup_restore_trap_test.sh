#!/usr/bin/env bash
# Unit test: restore EXIT trap must NOT restart API when swap is unsafe.
# Explicit partial-swap failure and signal-style EXIT both leave API stopped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"

# Unit tests exercise restore trap logic only — skip cross-command flock.
TOKENPANEL_SKIP_MANAGER_LOCK=1

APP_YML="/dev/null"
BACKUP_DIR="$(mktemp -d)"
MONGODB_DB="tokenpanel"
MONGO_USER_URI="u"
MONGO_PASS_URI="p"
LOG="$(mktemp)"
trap 'rm -rf "$BACKUP_DIR"; rm -f "$LOG"' EXIT

docker() {
  if [ "${1:-}" != "compose" ]; then
    echo "unexpected docker invocation: $*" >&2
    return 1
  fi
  shift
  if [ "${1:-}" = "-f" ]; then
    shift 2
  fi
  local op="${1:-}"
  case "$op" in
    start)
      echo "START:$2" >>"$LOG"
      ;;
    stop)
      echo "STOP:$2" >>"$LOG"
      ;;
    *)
      # Other compose ops unused in trap unit tests.
      ;;
  esac
}
export -f docker

# shellcheck source=../backup.sh
source "$ROOT/manager/lib/backup.sh"

fail() {
  echo "FAIL: $*"
  exit 1
}

# --- safe abort: swap not started → EXIT trap restarts API ---
: >"$LOG"
_RESTORE_SWAP_UNSAFE=0
_RESTORE_PRE_BACKUP=""
(
  trap '_restore_api_exit_trap' EXIT
  # Simulate unexpected shell exit before swap (e.g. killed during temp restore).
  exit 0
)
seq="$(tr '\n' ' ' <"$LOG" | sed 's/ *$//')"
[ "$seq" = "START:api" ] || fail "safe EXIT should restart api, got '$seq'"
echo "OK: safe EXIT restarts api"

# --- unsafe abort: mid-swap → EXIT trap must NOT restart API ---
: >"$LOG"
_RESTORE_SWAP_UNSAFE=1
_RESTORE_PRE_BACKUP="/var/tokenpanel/shared/backups/fake_pre-restore.gz"
trap_out="$(
  (
    trap '_restore_api_exit_trap' EXIT
    # Simulate signal/abort during destructive drop+rename.
    exit 1
  ) 2>&1 || true
)"
seq="$(tr '\n' ' ' <"$LOG" | sed 's/ *$//')"
[ -z "$seq" ] || fail "unsafe EXIT must not restart api, got '$seq'"
echo "$trap_out" | grep -q "API left STOPPED" || fail "unsafe EXIT missing STOPPED warning: $trap_out"
echo "$trap_out" | grep -q "PARTIALLY restored" || fail "unsafe EXIT missing partial warning: $trap_out"
echo "$trap_out" | grep -q "tokenpanel restore" || fail "unsafe EXIT missing recover hint: $trap_out"
echo "OK: unsafe EXIT leaves api stopped + recovery hint"

# --- after clean swap success flag cleared → EXIT trap restarts (safe) ---
: >"$LOG"
_RESTORE_SWAP_UNSAFE=0
(
  trap '_restore_api_exit_trap' EXIT
  exit 0
)
seq="$(tr '\n' ' ' <"$LOG" | sed 's/ *$//')"
[ "$seq" = "START:api" ] || fail "post-success EXIT should restart api, got '$seq'"
echo "OK: post-success EXIT restarts api"

# Extract mongosh --eval payload from docker compose exec argv.
_mongosh_eval() {
  local a next=0
  for a in "$@"; do
    if [ "$next" -eq 1 ]; then
      printf '%s' "$a"
      return 0
    fi
    [ "$a" = "--eval" ] && next=1
  done
  return 1
}

# --- _restore_into_temp sets/clears flag around swap ---
: >"$LOG"
# Fake docker for _restore_into_temp: temp restore ok, swap succeeds.
# Order matters: swap eval also contains getCollectionNames — match rename first.
docker() {
  if [ "${1:-}" != "compose" ]; then return 1; fi
  shift
  if [ "${1:-}" = "-f" ]; then shift 2; fi
  local op="${1:-}"
  case "$op" in
    exec)
      shift
      [ "${1:-}" = "-T" ] && shift
      shift # mongo
      local tool="${1:-}"
      case "$tool" in
        mongosh)
          local eval_arg
          eval_arg="$(_mongosh_eval "$@")" || eval_arg=""
          if [[ "$eval_arg" == *renameCollection* ]]; then
            echo "SWAP_OK 3"
            # Flag must already be set for the duration of the swap command.
            [ "${_RESTORE_SWAP_UNSAFE:-0}" -eq 1 ] || fail "flag not set during swap"
            return 0
          fi
          if [[ "$eval_arg" == *getCollectionNames\(\).length* ]]; then
            echo "3"
            return 0
          fi
          # dropDatabase cleanup / other — ok
          return 0
          ;;
        mongorestore)
          return 0
          ;;
        *)
          return 0
          ;;
      esac
      ;;
    *)
      return 0
      ;;
  esac
}
export -f docker

_RESTORE_SWAP_UNSAFE=0
# Provide a dummy archive path (mongorestore is faked; file only needs to exist for redirect).
archive="$BACKUP_DIR/test.gz"
printf 'x' >"$archive"
set +e
_restore_into_temp "$archive" "tokenpanel__restore_tmp" "tokenpanel" "mongodb://u:p@localhost:27017/admin"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "_restore_into_temp success expected rc=0 got $rc"
[ "${_RESTORE_SWAP_UNSAFE:-1}" -eq 0 ] || fail "flag should be 0 after successful swap"
echo "OK: _restore_into_temp clears unsafe flag on success"

# Swap failure leaves flag set.
docker() {
  if [ "${1:-}" != "compose" ]; then return 1; fi
  shift
  if [ "${1:-}" = "-f" ]; then shift 2; fi
  local op="${1:-}"
  case "$op" in
    exec)
      shift
      [ "${1:-}" = "-T" ] && shift
      shift
      local tool="${1:-}"
      case "$tool" in
        mongosh)
          local eval_arg
          eval_arg="$(_mongosh_eval "$@")" || eval_arg=""
          if [[ "$eval_arg" == *renameCollection* ]]; then
            echo "SWAP_PARTIAL moved=1 failed=1"
            return 1
          fi
          if [[ "$eval_arg" == *getCollectionNames\(\).length* ]]; then
            echo "2"
            return 0
          fi
          return 0
          ;;
        mongorestore) return 0 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 0 ;;
  esac
}
export -f docker

_RESTORE_SWAP_UNSAFE=0
set +e
_restore_into_temp "$archive" "tokenpanel__restore_tmp" "tokenpanel" "mongodb://u:p@localhost:27017/admin"
rc=$?
set -e
[ "$rc" -eq 2 ] || fail "_restore_into_temp partial swap expected rc=2 got $rc"
[ "${_RESTORE_SWAP_UNSAFE:-0}" -eq 1 ] || fail "flag should stay 1 after swap failure"
echo "OK: _restore_into_temp leaves unsafe flag set on swap failure"

# --- restore_backup runs post migrations after a successful restore ---
# Phase-6 failure recovery: restoring a pre-update backup onto newer code
# leaves the schema lagging the image. restore_backup must call
# run_migrations post after wait_for_health so the first request does not
# hit a schema mismatch. Idempotent via `_migrations`.
: >"$LOG"
DOMAIN="test.example.com"
export DOMAIN

# Comprehensive docker mock covering the full restore_backup flow:
# create_backup (pre-restore: stats + dump + verify + stop/start) and
# _restore_into_temp (mongorestore into temp + mongosh swap) + api restart.
docker() {
  if [ "${1:-}" != "compose" ]; then return 1; fi
  shift
  if [ "${1:-}" = "-f" ]; then shift 2; fi
  local op="${1:-}"
  case "$op" in
    ps)
      # _api_is_running: grep -qx 'api' matches this single line.
      echo "api"
      ;;
    stop)
      echo "STOP:$2" >>"$LOG"
      ;;
    start)
      echo "START:$2" >>"$LOG"
      ;;
    exec)
      shift  # exec
      [ "${1:-}" = "-T" ] && shift
      local svc="${1:-}"; shift
      local tool="${1:-}"
      case "$tool" in
        mongosh)
          local eval_arg
          eval_arg="$(_mongosh_eval "$@")" || eval_arg=""
          # create_backup: db.stats() for the disk-size estimate.
  if [[ "$eval_arg" == *"db.stats()"* ]]; then
            echo '{"dataSize":1048576,"indexSize":0}'
            return 0
          fi
          # _restore_into_temp: collection count for the temp DB check.
          if [[ "$eval_arg" == *getCollectionNames\(\).length* ]]; then
            echo "3"
            return 0
          fi
          # _restore_into_temp: drop+rename swap.
          if [[ "$eval_arg" == *renameCollection* ]]; then
            echo "SWAP_OK 3"
            return 0
          fi
          # _drop_temp_db (dropDatabase cleanup) — no output needed.
          return 0
          ;;
        mongodump)
          # create_backup writes this to the backup archive path.
          printf 'fake-archive'
          return 0
          ;;
        mongorestore)
          # restore_backup dryRun verify + create_backup verify + temp restore.
          return 0
          ;;
        *)
          return 0
          ;;
      esac
      ;;
    *)
      return 0
      ;;
  esac
}
export -f docker

# Skip the interactive domain confirm: set the named var to DOMAIN.
tp_read_required() {
  local __var="$1"
  printf -v "$__var" '%s' "$DOMAIN"
  return 0
}
export -f tp_read_required

# Skip real docker health probes (create_backup resume + restore restart).
wait_for_health() { return 0; }
export -f wait_for_health

# Mock run_migrations: record the phase, never fail. Defining this BEFORE
# the call means restore_backup's `declare -F` check skips sourcing
# migrate.sh and uses this mock instead.
_MIGRATE_CALLS=""
run_migrations() {
  _MIGRATE_CALLS="${_MIGRATE_CALLS:+$_MIGRATE_CALLS }$1"
  return 0
}
export -f run_migrations

RESTORE_ARCHIVE="$BACKUP_DIR/restore-src.gz"
printf 'fake-restore-archive' >"$RESTORE_ARCHIVE"

set +e
restore_backup "$RESTORE_ARCHIVE" >/dev/null 2>&1
rc=$?
set -e
# restore_backup clears the test's EXIT trap (trap - EXIT inside the fn).
# Re-set it so the script-exit cleanup (rm -rf BACKUP_DIR / LOG) still runs.
trap 'rm -rf "$BACKUP_DIR"; rm -f "$LOG"' EXIT

[ "$rc" -eq 0 ] || fail "restore_backup should succeed (rc=$rc); log: $(tr '\n' ' ' <"$LOG")"
[ -n "$_MIGRATE_CALLS" ] || fail "run_migrations not called after restore"
[[ "$_MIGRATE_CALLS" == *post* ]] || fail "run_migrations post not called (got: $_MIGRATE_CALLS)"
echo "OK: restore_backup calls run_migrations post (calls: $_MIGRATE_CALLS)"

echo "ALL PASS"
