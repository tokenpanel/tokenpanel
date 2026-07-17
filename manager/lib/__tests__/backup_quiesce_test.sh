#!/usr/bin/env bash
# Unit test: create_backup stops the API before mongodump and restarts after.
# Also verifies dump failure still restarts the API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"

APP_YML="/dev/null"
BACKUP_DIR="$(mktemp -d)"
MONGODB_DB="tokenpanel"
MONGO_USER_URI="u"
MONGO_PASS_URI="p"
trap 'rm -rf "$BACKUP_DIR"' EXIT

LOG="$(mktemp)"
trap 'rm -rf "$BACKUP_DIR"; rm -f "$LOG"' EXIT

# Fake docker compose: record ordered operations; simulate api running.
docker() {
  # Expected forms:
  #   docker compose -f ... ps --status running --services
  #   docker compose -f ... stop api
  #   docker compose -f ... start api
  #   docker compose -f ... exec -T mongo mongosh ...
  #   docker compose -f ... exec -T mongo mongodump ...
  #   docker compose -f ... exec -T mongo mongorestore ...
  if [ "${1:-}" != "compose" ]; then
    echo "unexpected docker invocation: $*" >&2
    return 1
  fi
  shift # compose
  # skip -f APP_YML
  if [ "${1:-}" = "-f" ]; then
    shift 2
  fi

  local op="${1:-}"
  case "$op" in
    ps)
      echo "api"
      echo "mongo"
      ;;
    stop)
      echo "STOP:$2" >>"$LOG"
      ;;
    start)
      echo "START:$2" >>"$LOG"
      ;;
    exec)
      # ... -T mongo <tool> ...
      shift # exec
      [ "${1:-}" = "-T" ] && shift
      local svc="${1:-}"; shift
      local tool="${1:-}"
      case "$tool" in
        mongosh)
          # db.stats() for size check
          echo '{"dataSize":1048576,"indexSize":0}'
          ;;
        mongodump)
          echo "DUMP" >>"$LOG"
          # write a tiny gzip-ish payload to stdout (redirected to backup file)
          printf 'fake-archive'
          if [ "${FORCE_DUMP_FAIL:-0}" -eq 1 ]; then
            return 1
          fi
          ;;
        mongorestore)
          echo "VERIFY" >>"$LOG"
          if [ "${FORCE_VERIFY_FAIL:-0}" -eq 1 ]; then
            return 1
          fi
          ;;
        *)
          echo "unexpected exec tool: $tool" >&2
          return 1
          ;;
      esac
      ;;
    *)
      echo "unexpected compose op: $op ($*)" >&2
      return 1
      ;;
  esac
}
export -f docker

# Plenty of free space so the disk check passes (df of BACKUP_DIR).
# shellcheck source=../backup.sh
source "$ROOT/manager/lib/backup.sh"

# --- happy path: stop → dump → verify → start ---
: >"$LOG"
FORCE_DUMP_FAIL=0
FORCE_VERIFY_FAIL=0
out="$(create_backup "test")"
seq="$(tr '\n' ' ' <"$LOG" | sed 's/ *$//')"
expected="STOP:api DUMP VERIFY START:api"
if [ "$seq" != "$expected" ]; then
  echo "FAIL: order was '$seq', expected '$expected'"
  exit 1
fi
if [ ! -f "$out" ]; then
  echo "FAIL: backup file missing: $out"
  exit 1
fi
if [ "${BACKUP_API_WAS_RUNNING:-0}" -ne 0 ]; then
  echo "FAIL: BACKUP_API_WAS_RUNNING should be 0 after success"
  exit 1
fi
echo "OK: stop → dump → verify → start ($seq)"

# --- dump failure still resumes api ---
: >"$LOG"
FORCE_DUMP_FAIL=1
set +e
create_backup "fail-dump" >/dev/null
rc=$?
set -e
seq="$(tr '\n' ' ' <"$LOG" | sed 's/ *$//')"
if [ "$rc" -eq 0 ]; then
  echo "FAIL: dump failure should return non-zero"
  exit 1
fi
if [ "$seq" != "STOP:api DUMP START:api" ]; then
  echo "FAIL: dump-fail order was '$seq', expected 'STOP:api DUMP START:api'"
  exit 1
fi
echo "OK: dump failure still restarts api ($seq)"

# --- verify failure still resumes api ---
: >"$LOG"
FORCE_DUMP_FAIL=0
FORCE_VERIFY_FAIL=1
set +e
create_backup "fail-verify" >/dev/null
rc=$?
set -e
seq="$(tr '\n' ' ' <"$LOG" | sed 's/ *$//')"
if [ "$rc" -eq 0 ]; then
  echo "FAIL: verify failure should return non-zero"
  exit 1
fi
if [ "$seq" != "STOP:api DUMP VERIFY START:api" ]; then
  echo "FAIL: verify-fail order was '$seq', expected 'STOP:api DUMP VERIFY START:api'"
  exit 1
fi
echo "OK: verify failure still restarts api ($seq)"

echo "ALL PASS"
