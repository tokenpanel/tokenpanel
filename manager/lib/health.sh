#!/usr/bin/env bash
# Health check polling — sourced by bin/tokenpanel.

wait_for_health() {
  local service="${1:-api}"
  local timeout="${2:-60}"
  local elapsed=0
  step "health" "waiting for $service (max ${timeout}s)..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if docker compose -f "$APP_YML" exec -T "$service" \
      bun -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
      2>/dev/null; then
      ok "$service healthy"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  err "$service did not become healthy in ${timeout}s"
  return 1
}
