#!/usr/bin/env bash

tp_service_status() {
  local service="$1"
  local container_id
  container_id="$(docker compose -f "$APP_YML" ps -q "$service" 2>/dev/null | head -1)"
  [ -n "$container_id" ] || return 1
  local status
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null)"
  [ "$status" = "healthy" ] || [ "$status" = "running" ]
}

wait_for_health() {
  local service="${1:-api}"
  local timeout="${2:-180}"
  local start=$SECONDS
  local deadline=$((start + timeout))

  step "health" "waiting for $service to become healthy (max ${timeout}s)..."
  while true; do
    if tp_service_status "$service"; then
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
