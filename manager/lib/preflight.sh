#!/usr/bin/env bash
# Pre-flight checks — sourced by bin/tokenpanel.

require_config() {
  local required_csv=""
  local manifest_env="${GENERATED_DIR:-${CONFIG_DIR}/generated}/manifest.env"
  if [ ! -f "$manifest_env" ]; then
    manifest_env="${MANAGER_DIR}/release/manifest.env"
  fi
  if [ -f "$manifest_env" ]; then
    required_csv="$(grep -E '^REQUIRED_KEYS=' "$manifest_env" 2>/dev/null | head -1 | cut -d= -f2-)"
  fi

  local -a required
  if [ -n "$required_csv" ]; then
    IFS=',' read -r -a required <<< "$required_csv"
  else
    required=(MONGO_USER MONGO_PASS MONGODB_DB DOMAIN ADMIN_EMAIL JWT_SECRET)
  fi

  local missing=0
  local var val
  for var in "${required[@]}"; do
    [ -n "$var" ] || continue
    val="${!var:-}"
    if [ -z "$val" ]; then
      err "config missing: $var is not set. Check $ENV_FILE or run: tokenpanel config render"
      missing=1
    fi
  done
  return "$missing"
}

preflight_quick() {
  [ "$(id -u)" -eq 0 ] || { err "must run as root"; return 1; }
  docker info >/dev/null 2>&1 || { err "docker not running"; return 1; }
  [ -f "$APP_YML" ] || { err "config not found at $APP_YML. Run tokenpanel-setup first."; return 1; }
  [ -f "$ENV_FILE" ] || { err "config not found at $ENV_FILE. Run tokenpanel-setup or tokenpanel config render."; return 1; }
  require_config || return 1
  return 0
}

preflight_full() {
  preflight_quick || return 1
  local free_mb
  free_mb="$(df -m /var 2>/dev/null | tail -1 | awk '{print $4}')"
  [ "${free_mb:-0}" -gt 5120 ] || { err "insufficient disk: ${free_mb}MB free, need >5GB"; return 1; }
  docker compose -f "$APP_YML" exec -T mongo mongosh --quiet \
    --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true || {
    err "mongo not reachable or not primary"; return 1; 
  }
  return 0
}
