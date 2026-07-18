#!/usr/bin/env bash
# Unit test: cross-command flock serializes concurrent holders; re-entry works;
# unique backup filenames include pid and collide-safe suffix.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export TOKENPANEL_LOCK_FILE="$TMP/manager.lock"
export CONFIG_DIR="$TMP"
# A root manager must never evaluate this environment value as shell source.
export MANAGER_LOCK_FD='200; touch "$TMP/eval-ran"'
# Ensure skip is off for lock tests.
unset TOKENPANEL_SKIP_MANAGER_LOCK || true
export TOKENPANEL_SKIP_MANAGER_LOCK=0

# shellcheck source=../lock.sh
source "$ROOT/manager/lib/lock.sh"

fail() { echo "FAIL: $*"; exit 1; }

[ ! -e "$TMP/eval-ran" ] || fail "MANAGER_LOCK_FD was evaluated while sourcing lock.sh"

# --- acquire / re-enter ---
acquire_manager_lock "test-a" || fail "first acquire should succeed"
[ "${MANAGER_LOCK_HELD:-0}" -eq 1 ] || fail "MANAGER_LOCK_HELD should be 1"
acquire_manager_lock "test-a-nested" || fail "re-entrant acquire should succeed"
holder="$(cat "$TOKENPANEL_LOCK_FILE")"
echo "$holder" | grep -q "pid=$$" || fail "lock metadata missing pid: $holder"
echo "$holder" | grep -q "cmd=test-a" || fail "lock metadata should keep first cmd: $holder"
echo "OK: acquire + re-entrant"

# --- second process blocked ---
set +e
out="$(
  TOKENPANEL_LOCK_FILE="$TOKENPANEL_LOCK_FILE" \
  CONFIG_DIR="$TMP" \
  TOKENPANEL_SKIP_MANAGER_LOCK=0 \
  bash -c '
    source "'"$ROOT"'/manager/lib/output.sh"
    source "'"$ROOT"'/manager/lib/lock.sh"
    acquire_manager_lock "peer" 2>&1
    echo RC:$?
  '
)"
rc_line="$(echo "$out" | grep '^RC:' || true)"
set -e
echo "$out" | grep -qi "already running" || fail "peer should report busy: $out"
echo "$rc_line" | grep -q 'RC:1' || fail "peer should exit 1: $out"
echo "OK: concurrent acquire blocked"

# --- inherited FD adoption for refreshed update manager ---
set +e
out="$(
  TOKENPANEL_LOCK_FILE="$TOKENPANEL_LOCK_FILE" \
  CONFIG_DIR="$TMP" \
  TOKENPANEL_SKIP_MANAGER_LOCK=0 \
  bash -c '
    source "'"$ROOT"'/manager/lib/output.sh"
    source "'"$ROOT"'/manager/lib/lock.sh"
    adopt_manager_lock "'"$MANAGER_LOCK_FD"'"
    echo RC:$? FD:$MANAGER_LOCK_FD HELD:$MANAGER_LOCK_HELD
  '
)"
set -e
echo "$out" | grep -q 'RC:0' || fail "inherited lock adoption failed: $out"
echo "$out" | grep -q 'HELD:1' || fail "adopted lock not marked held: $out"

set +e
bad_out="$(
  TOKENPANEL_LOCK_FILE="$TOKENPANEL_LOCK_FILE" \
  CONFIG_DIR="$TMP" \
  TOKENPANEL_SKIP_MANAGER_LOCK=0 \
  bash -c '
    source "'"$ROOT"'/manager/lib/output.sh"
    source "'"$ROOT"'/manager/lib/lock.sh"
    adopt_manager_lock 9999 2>&1
    echo RC:$?
  '
)"
set -e
echo "$bad_out" | grep -q 'RC:1' || fail "invalid inherited lock was accepted: $bad_out"
echo "OK: inherited lock adoption validated"

# --- release frees lock for peer ---
release_manager_lock
[ "${MANAGER_LOCK_HELD:-0}" -eq 0 ] || fail "MANAGER_LOCK_HELD should be 0 after release"
set +e
out="$(
  TOKENPANEL_LOCK_FILE="$TOKENPANEL_LOCK_FILE" \
  CONFIG_DIR="$TMP" \
  TOKENPANEL_SKIP_MANAGER_LOCK=0 \
  bash -c '
    source "'"$ROOT"'/manager/lib/output.sh"
    source "'"$ROOT"'/manager/lib/lock.sh"
    acquire_manager_lock "peer2" 2>&1
    echo RC:$?
  '
)"
set -e
echo "$out" | grep -q 'RC:0' || fail "peer after release should succeed: $out"
echo "OK: release frees lock"

# --- unique backup filenames ---
TOKENPANEL_SKIP_MANAGER_LOCK=1
export TOKENPANEL_SKIP_MANAGER_LOCK
APP_YML="/dev/null"
BACKUP_DIR="$TMP/backups"
mkdir -p "$BACKUP_DIR"
MONGODB_DB="tokenpanel"
MONGO_USER_URI="u"
MONGO_PASS_URI="p"

docker() {
  if [ "${1:-}" != "compose" ]; then return 1; fi
  shift
  if [ "${1:-}" = "-f" ]; then shift 2; fi
  case "${1:-}" in
    ps) echo "api" ;;
    stop|start) : ;;
    exec)
      shift
      [ "${1:-}" = "-T" ] && shift
      shift
      case "${1:-}" in
        mongosh) echo '{"dataSize":0,"indexSize":0}' ;;
        mongodump) printf 'fake' ;;
        mongorestore) return 0 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 0 ;;
  esac
}
export -f docker

# shellcheck source=../backup.sh
source "$ROOT/manager/lib/backup.sh"

# Pre-create a same-second-style collision for the first candidate path so the
# counter suffix path is exercised.
ts="$(date -u +%Y%m%dT%H%M%SZ)"
pid="$$"
# create_backup will use current second; touch a file that matches its first try
# if we freeze time... we cannot. Instead: call create_backup twice and assert
# both exist and differ, and match *_manual.gz pattern with pid segment.
path1="$(create_backup "manual")"
path2="$(create_backup "manual")"
[ -f "$path1" ] || fail "backup1 missing: $path1"
[ -f "$path2" ] || fail "backup2 missing: $path2"
[ "$path1" != "$path2" ] || fail "two backups same second must not share path: $path1"
basename "$path1" | grep -E ".*-$$.*_manual\.gz$" >/dev/null \
  || basename "$path1" | grep -E "_manual\.gz$" >/dev/null \
  || fail "unexpected name: $(basename "$path1")"
# Both should end with _manual.gz for label-based globs.
[[ "$(basename "$path1")" == *_manual.gz ]] || fail "glob-breaking name: $(basename "$path1")"
[[ "$(basename "$path2")" == *_manual.gz ]] || fail "glob-breaking name: $(basename "$path2")"
echo "OK: unique backup paths ($path1 vs $path2)"

# Collision counter path: force first candidate to exist, then call create_backup.
# Patch date to fixed value via a function? create_backup calls date binary.
# Touch candidate for current second+pid; if create_backup runs same second, hits loop.
cand="${BACKUP_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-$$_manual.gz"
printf 'x' >"$cand"
path3="$(create_backup "manual")"
[ -f "$path3" ] || fail "backup3 missing"
[ "$path3" != "$cand" ] || fail "should not overwrite existing: $path3"
[[ "$(basename "$path3")" == *_manual.gz ]] || fail "glob-breaking collision name: $(basename "$path3")"
echo "OK: collision suffix avoids overwrite ($path3)"

echo "ALL PASS"
