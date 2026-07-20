#!/usr/bin/env bash
# Container swap with health-check-gated auto-rollback.

swap_containers() {
  step "swap" "recreating api container..."

  # --force-recreate guarantees the container is rebuilt against the newly
  # tagged tokenpanel/app:current image. Without it, Compose may leave the
  # existing container running because the image *tag* is unchanged (only the
  # underlying image ID changed), making the swap a no-op.
  docker compose -f "$APP_YML" up -d --no-deps --force-recreate api

  if ! wait_for_health api 180; then
    err "new container failed health check within 180s"
    rollback_to_previous || err "ROLLBACK FAILED — manual intervention required"
    return 1
  fi

  ok "api healthy on new image"
  return 0
}

rollback_to_previous() {
  warn "AUTO-ROLLBACK: reverting to previous image..."

  docker compose -f "$APP_YML" stop api 2>/dev/null || true

  if declare -F restore_previous_config >/dev/null 2>&1; then
    restore_previous_config || warn "could not restore previous config snapshot"
  fi

  if docker image inspect tokenpanel/app:previous >/dev/null 2>&1; then
    docker tag tokenpanel/app:previous tokenpanel/app:current
    docker compose -f "$APP_YML" up -d --no-deps --force-recreate api

    if wait_for_health api 180; then
      warn "rolled back to previous version — app is serving old code"
      warn "investigate the failure, fix, then retry: tokenpanel update"
      return 0
    else
      err "ROLLBACK FAILED — old container also unhealthy"
      err "manual intervention required. Check: docker logs tokenpanel-api-1"
      err "last resort: tokenpanel restore $BACKUP_DIR/<latest>.gz"
      return 1
    fi
  else
    err "no previous image found — cannot rollback"
    err "manual intervention required."
    return 1
  fi
}
