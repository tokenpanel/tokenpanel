#!/usr/bin/env bash
# Unit test: wait_for_health hard-caps the outer docker compose exec.
# Simulates a hung docker that sleeps longer than the health timeout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh" 2>/dev/null || {
  # Minimal stubs if output.sh needs more env
  step() { :; }
  ok() { :; }
  err() { echo "$*" >&2; }
}

APP_YML="/dev/null"

# Fake docker: ignore compose args and sleep 2s (longer than timeout=1).
docker() {
  sleep 2
  return 1
}
export -f docker

# shellcheck source=../health.sh
source "$ROOT/manager/lib/health.sh"

start=$SECONDS
set +e
wait_for_health api 1 /ready
rc=$?
set -e
elapsed=$((SECONDS - start))

if [ "$rc" -eq 0 ]; then
  echo "FAIL: wait_for_health should fail when docker never succeeds"
  exit 1
fi

# Must not wait for the full docker sleep (2s) when timeout is 1s.
# Allow 1s budget + small shell overhead (< 1.8s total).
if [ "$elapsed" -ge 2 ]; then
  echo "FAIL: wait_for_health took ${elapsed}s (expected < 2s with timeout=1)"
  exit 1
fi

echo "OK: wait_for_health timeout=1 returned in ${elapsed}s (rc=$rc)"
