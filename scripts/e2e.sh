#!/usr/bin/env bash
#
# One-command end-to-end run.
#
#   1. Build + start an ISOLATED stack (compose project `tokenpanel-e2e`,
#      dedicated mongo volume + host ports) from the production single-port image.
#   2. Wait for the API to be healthy on :3099.
#   3. Install the Playwright browser if missing, then run the E2E suite.
#   4. ALWAYS tear the stack down (`down -v`, wiping the throwaway DB).
#   5. Exit with the Playwright exit code (0 = all passed).
#
# This never touches the dev stack or dev data. It is intentionally NOT wired
# into `bun test` / CI-auto — run it manually before publishing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="tokenpanel-e2e"
BASE_URL="${E2E_BASE_URL:-http://localhost:3099}"
COMPOSE=(docker compose -f compose.e2e.yml -p "$PROJECT")

cleanup() {
  echo "==> Tearing down E2E stack…"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building + starting isolated E2E stack (project: $PROJECT)…"
"${COMPOSE[@]}" up --build -d --wait

echo "==> Waiting for API health at $BASE_URL/health…"
healthy=0
for _ in $(seq 1 90); do
  if bun -e "const r=await fetch('$BASE_URL/health');process.exit(r.ok?0:1)" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  echo "ERROR: API did not become healthy in time. Recent app logs:" >&2
  "${COMPOSE[@]}" logs --tail=80 app >&2 || true
  exit 1
fi

echo "==> Ensuring Playwright browser is installed…"
(cd apps/e2e && bunx playwright install chromium)

echo "==> Running E2E tests…"
set +e
(cd apps/e2e && E2E_BASE_URL="$BASE_URL" bunx playwright test)
code=$?
set -e

echo
if [ "$code" -eq 0 ]; then
  echo "==> E2E PASSED ✅"
else
  echo "==> E2E FAILED ❌ (exit $code)"
fi
exit "$code"
