#!/usr/bin/env bash
# A legacy current image may expose /health but predate /ready. Bootstrap
# commands may use that fallback; rollout health checks remain strict.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "$*" == *"/ready"* ]]; then exit 42; fi' \
  'if [[ "$*" == *"/health"* ]]; then exit 0; fi' \
  'exit 1' > "$TMP_DIR/docker"
chmod +x "$TMP_DIR/docker"

export PATH="$TMP_DIR:$PATH"
APP_YML="/dev/null"

# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"
# shellcheck source=../health.sh
source "$ROOT/manager/lib/health.sh"

set +e
wait_for_health api 1 /ready
strict_rc=$?
set -e

if [ "$strict_rc" -eq 0 ]; then
  echo "FAIL: strict /ready probe accepted a 404" >&2
  exit 1
fi

wait_for_health api 3 /ready 1 || {
  echo "FAIL: legacy fallback did not accept /health" >&2
  exit 1
}

# Only an explicit 404 proves endpoint absence. A 503/network-style failure
# must keep retrying /ready and must not weaken readiness to /health.
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "$*" == *"/ready"* ]]; then exit 1; fi' \
  'if [[ "$*" == *"/health"* ]]; then exit 0; fi' \
  'exit 1' > "$TMP_DIR/docker"
chmod +x "$TMP_DIR/docker"

set +e
wait_for_health api 1 /ready 1
failure_rc=$?
set -e
if [ "$failure_rc" -eq 0 ]; then
  echo "FAIL: non-404 readiness failure incorrectly used /health" >&2
  exit 1
fi

echo "OK: legacy /health fallback is bootstrap-only"
