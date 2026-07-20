#!/usr/bin/env bash

source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/output.sh"
source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/config.sh"

snapshot_config() {
  local ts snap
  ts="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  snap="${CONFIG_SNAPSHOT_DIR}/${ts}"
  mkdir -p "$snap"

  local f
  for f in app.yml .env Caddyfile tokenpanel.yml manager.env; do
    if [ -f "${CONFIG_DIR}/${f}" ]; then
      cp -fp "${CONFIG_DIR}/${f}" "${snap}/${f}"
    fi
  done
  if [ -d "$GENERATED_DIR" ]; then
    cp -rfp "$GENERATED_DIR" "${snap}/generated"
  fi
  mkdir -p "$CONFIG_SNAPSHOT_DIR"
  ln -sfn "$snap" "${CONFIG_SNAPSHOT_DIR}/latest"
  printf '%s\n' "$snap"
}

restore_config_snapshot() {
  local snap="$1"
  if [ -z "$snap" ] || [ ! -d "$snap" ]; then
    err "config snapshot not found: '$snap'"
    return 1
  fi

  rm -rf "$GENERATED_DIR"
  if [ -d "${snap}/generated" ]; then
    cp -rfp "${snap}/generated" "$GENERATED_DIR"
  fi

  local f
  for f in app.yml .env Caddyfile manager.env; do
    if [ -f "${snap}/${f}" ]; then
      cp -fp "${snap}/${f}" "${CONFIG_DIR}/${f}"
    else
      rm -f "${CONFIG_DIR:?}/${f}"
    fi
  done
  if [ -f "${snap}/tokenpanel.yml" ]; then
    cp -fp "${snap}/tokenpanel.yml" "${CONFIG_DIR}/tokenpanel.yml"
  fi

  tp_select_active_config
  if declare -F load_env_safe >/dev/null 2>&1; then
    load_env_safe "$ENV_FILE"
  fi
}

restore_previous_config() {
  local latest="${CONFIG_SNAPSHOT_DIR}/latest"
  if [ ! -L "$latest" ] && [ ! -d "$latest" ]; then
    return 0
  fi
  local snap
  snap="$(readlink -f "$latest" 2>/dev/null || printf '%s\n' "$latest")"
  step "config" "restoring previous configuration snapshot..."
  restore_config_snapshot "$snap"
}

ensure_operator_config() {
  local image_tag="$1"
  if [ -f "$OPERATOR_CONFIG" ]; then
    return 0
  fi
  if [ ! -f "${CONFIG_DIR}/.env" ]; then
    err "no operator config at ${OPERATOR_CONFIG} and no legacy .env to migrate"
    err "run: tokenpanel-setup"
    return 1
  fi
  step "config" "migrating legacy .env to tokenpanel.yml..."
  docker run --rm \
    -v "${CONFIG_DIR}:/etc/tokenpanel" \
    "tokenpanel/app:${image_tag}" \
    bun packages/config/src/cli.ts migrate-legacy \
      --legacy-env /etc/tokenpanel/.env \
      --out /etc/tokenpanel/tokenpanel.yml
}

render_config_from_image() {
  local image_tag="$1"
  local release_version="${2:-}"
  mkdir -p "$GENERATED_DIR"

  local -a args=(
    bun packages/config/src/cli.ts render
    --operator /etc/tokenpanel/tokenpanel.yml
    --legacy-env /etc/tokenpanel/.env
    --templates /app/manager/templates
    --out /etc/tokenpanel/generated
    --data-dir "$DATA_DIR"
    --generated-config-dir /etc/tokenpanel/generated
    --image-tag "$image_tag"
    --manager-version "$(cat "${MANAGER_DIR}/VERSION" 2>/dev/null || echo 0.0.0)"
  )
  if [ -n "$release_version" ]; then
    args+=(--release-version "$release_version")
  fi

  if ! docker run --rm -v "${CONFIG_DIR}:/etc/tokenpanel" "tokenpanel/app:${image_tag}" "${args[@]}"; then
    err "config render failed for tokenpanel/app:${image_tag}"
    return 1
  fi

  tp_select_active_config
  if declare -F load_env_safe >/dev/null 2>&1; then
    load_env_safe "$ENV_FILE"
  fi
  return 0
}

check_operator_config() {
  local image_tag="$1"
  docker run --rm \
    -v "${CONFIG_DIR}:/etc/tokenpanel" \
    "tokenpanel/app:${image_tag}" \
    bun packages/config/src/cli.ts check \
      --operator /etc/tokenpanel/tokenpanel.yml \
      --legacy-env /etc/tokenpanel/.env
}
