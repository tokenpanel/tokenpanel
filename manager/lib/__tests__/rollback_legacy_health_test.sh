#!/usr/bin/env bash
# New-image readiness stays strict; rollback to a previous legacy image may
# fall back from /ready to /health.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
PROBES="$TMP_DIR/probes"
trap 'rm -rf "$TMP_DIR"' EXIT

APP_YML="$TMP_DIR/app.yml"
BACKUP_DIR="$TMP_DIR/backups"
touch "$APP_YML" "$PROBES"

# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"

docker() { return 0; }
wait_for_health() {
  printf '%s\n' "$*" >>"$PROBES"
  [ "$#" -eq 4 ] && [ "${4:-}" = "1" ]
}

# shellcheck source=../rollback.sh
source "$ROOT/manager/lib/rollback.sh"

set +e
swap_containers >/dev/null 2>&1
rc=$?
set -e

[ "$rc" -eq 1 ] || { echo "FAIL: failed target rollout should return 1" >&2; exit 1; }
[ "$(sed -n '1p' "$PROBES")" = "api 60" ] \
  || { echo "FAIL: target image probe was not strict" >&2; exit 1; }
[ "$(sed -n '2p' "$PROBES")" = "api 60 /ready 1" ] \
  || { echo "FAIL: previous image probe lacks legacy fallback" >&2; exit 1; }

echo "OK: rollout strict, legacy rollback compatible"
