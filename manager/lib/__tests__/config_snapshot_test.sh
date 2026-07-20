#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export TOKENPANEL_CONFIG_DIR="$TMP_DIR/etc"
mkdir -p "$TOKENPANEL_CONFIG_DIR"

printf 'old-compose\n' > "$TOKENPANEL_CONFIG_DIR/app.yml"
printf 'OLD=1\n' > "$TOKENPANEL_CONFIG_DIR/.env"

source "$ROOT/manager/lib/config_render.sh"

snap="$(snapshot_config)"
[ -d "$snap" ] || { echo "FAIL: snapshot missing" >&2; exit 1; }

printf 'new-compose\n' > "$TOKENPANEL_CONFIG_DIR/app.yml"
mkdir -p "$GENERATED_DIR"
printf 'name: tokenpanel\n' > "$GENERATED_DIR/compose.yml"
tp_select_active_config

restore_previous_config

[ "$APP_YML" = "$TOKENPANEL_CONFIG_DIR/app.yml" ] || {
  echo "FAIL: active compose not restored: $APP_YML" >&2
  exit 1
}
[ "$(cat "$TOKENPANEL_CONFIG_DIR/app.yml")" = "old-compose" ] || {
  echo "FAIL: old compose content not restored" >&2
  exit 1
}
[ ! -e "$GENERATED_DIR/compose.yml" ] || {
  echo "FAIL: generated config not removed on rollback" >&2
  exit 1
}

echo "OK: config snapshot restores pre-update config and removes generated artifacts"
