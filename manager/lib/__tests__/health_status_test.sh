#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

APP_YML="/dev/null"

# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"
# shellcheck source=../health.sh
source "$ROOT/manager/lib/health.sh"

docker() {
  if [[ "$*" == *"ps --status healthy --services"* ]]; then
    printf 'api\n'
  fi
  return 0
}

wait_for_health api 2 >/dev/null || {
  echo "FAIL: healthy service was not accepted" >&2
  exit 1
}

docker() {
  return 0
}

if wait_for_health api 1 >/dev/null 2>&1; then
  echo "FAIL: unhealthy service was accepted" >&2
  exit 1
fi

echo "OK: health waits for Docker compose healthy status"
