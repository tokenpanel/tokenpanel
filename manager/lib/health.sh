#!/usr/bin/env bash

wait_for_health() {
  local service="${1:-api}"
  local timeout="${2:-180}"
  local start=$SECONDS
  local deadline=$((start + timeout))

  step "health" "waiting for $service to become healthy (max ${timeout}s)..."
  while true; do
    if docker compose -f "$APP_YML" ps --status healthy --services 2>/dev/null | grep -qx "$service"; then
      ok "$service healthy"
      return 0
    fi

    local remaining=$((deadline - SECONDS))
    if [ "$remaining" -le 0 ]; then
      break
    fi

    local sleep_s=2
    if [ "$remaining" -lt "$sleep_s" ]; then
      sleep_s=$remaining
    fi
    if [ "$sleep_s" -gt 0 ]; then
      sleep "$sleep_s"
    fi
  done

  err "$service did not become healthy within ${timeout}s"
  return 1
}

wait_for_live() {
  wait_for_health "${1:-api}" "${2:-30}"
}
