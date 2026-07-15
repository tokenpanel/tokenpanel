#!/usr/bin/env bash
# Health check polling — sourced by bin/tokenpanel.
# Uses /ready (Mongo ping) for rollout decisions; /live is process-only.

wait_for_health() {
  local service="${1:-api}"
  local timeout="${2:-60}"
  local path="${3:-/ready}"
  # Monotonic-ish deadline via SECONDS (bash special: increments once per
  # real second, immune to wall-clock jumps within the shell process).
  local start=$SECONDS
  local max_attempt_timeout_ms=5000
  local deadline=$((start + timeout))

  step "health" "waiting for $service ${path} (max ${timeout}s)..."
  while true; do
    local now=$SECONDS
    local remaining=$((deadline - now))
    if [ "$remaining" -le 0 ]; then
      break
    fi

    # Cap this attempt's fetch abort to remaining wall budget so we never
    # overrun the configured timeout by a full fetch + sleep.
    local this_timeout_ms=$((remaining * 1000))
    if [ "$this_timeout_ms" -gt "$max_attempt_timeout_ms" ]; then
      this_timeout_ms=$max_attempt_timeout_ms
    fi
    # Ensure at least 100ms so bun's timer is meaningful.
    if [ "$this_timeout_ms" -lt 100 ]; then
      this_timeout_ms=100
    fi

    # Outer hard deadline: docker compose exec IPC is outside fetch's
    # AbortController. Wrap the whole attempt so a hung docker cannot push
    # wait_for_health past the configured timeout (e.g. timeout=1 with a
    # 2s docker hang must return in ~1s, not 2s+).
    local outer_s=$remaining
    if [ "$outer_s" -lt 1 ]; then
      outer_s=1
    fi

    if timeout --preserve-status --kill-after=1s "${outer_s}s" \
      docker compose -f "$APP_YML" exec -T "$service" \
      bun -e "
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ${this_timeout_ms});
        fetch('http://127.0.0.1:3000${path}', { signal: ctrl.signal })
          .then(r => { clearTimeout(t); process.exit(r.ok ? 0 : 1); })
          .catch(() => { clearTimeout(t); process.exit(1); });
      " 2>/dev/null; then
      # Probe may have returned ok after the deadline while the shell waited.
      # Never report success past the configured timeout.
      if [ $((SECONDS - start)) -ge "$timeout" ]; then
        break
      fi
      ok "$service ready (${path})"
      return 0
    fi

    now=$SECONDS
    remaining=$((deadline - now))
    if [ "$remaining" -le 0 ]; then
      break
    fi
    # Sleep at most 2s, never past the deadline.
    local sleep_s=2
    if [ "$remaining" -lt "$sleep_s" ]; then
      sleep_s=$remaining
    fi
    # Skip zero-length sleeps (would busy-loop).
    if [ "$sleep_s" -gt 0 ]; then
      sleep "$sleep_s"
    fi
  done
  err "$service did not become ready at ${path} within ${timeout}s"
  return 1
}

wait_for_live() {
  wait_for_health "${1:-api}" "${2:-30}" "/live"
}
