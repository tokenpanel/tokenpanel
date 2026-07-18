#!/usr/bin/env bash
# Each probe must be hard-capped so one hung legacy runtime cannot consume the
# entire health deadline before fallback/retry logic runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
ATTEMPTS="$TMP_DIR/attempts"
trap 'rm -rf "$TMP_DIR"' EXIT
touch "$ATTEMPTS"

APP_YML="/dev/null"

# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"

timeout() {
  while [[ "${1:-}" == --* ]]; do shift; done
  local duration="${1%s}"
  printf '%s\n' "$duration" >>"$ATTEMPTS"
  SECONDS=$((SECONDS + duration))
  return 1
}

sleep() {
  SECONDS=$((SECONDS + ${1:-0}))
}

# shellcheck source=../health.sh
source "$ROOT/manager/lib/health.sh"

set +e
wait_for_health api 12 /ready >/dev/null 2>&1
rc=$?
set -e

[ "$rc" -eq 1 ] || { echo "FAIL: hung probes should time out" >&2; exit 1; }
[ "$(wc -l <"$ATTEMPTS")" -ge 2 ] \
  || { echo "FAIL: one probe consumed full deadline" >&2; exit 1; }
if awk '$1 > 5 { exit 1 }' "$ATTEMPTS"; then
  :
else
  echo "FAIL: probe exceeded 5-second attempt cap" >&2
  exit 1
fi

echo "OK: hung health attempts are capped at 5s"
