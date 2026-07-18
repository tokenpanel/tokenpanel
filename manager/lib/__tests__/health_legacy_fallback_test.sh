#!/usr/bin/env bash
# Legacy bootstrap uses frozen /health directly; rollout /ready remains strict.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "$*" == *"AbortController"* ]]; then exit 1; fi' \
  'if [[ "$*" == *"/ready"* ]]; then exit 1; fi' \
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

wait_for_health api 3 /health || {
  echo "FAIL: frozen legacy /health contract was not accepted" >&2
  exit 1
}

echo "OK: legacy /health contract is explicit; /ready stays strict"
