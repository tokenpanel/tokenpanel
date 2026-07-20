#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CONFIG_DIR="$TMP_DIR/etc"
mkdir -p "$CONFIG_DIR/generated"

cat > "$CONFIG_DIR/generated/compose.yml" <<'YAML'
name: tokenpanel
services: {}
YAML

cat > "$CONFIG_DIR/generated/manager.env" <<'ENV'
MONGO_USER=generated-user
NEW_DYNAMIC_KEY=dynamic-ok
ENV

cat > "$CONFIG_DIR/generated/allowed-env-keys.txt" <<'KEYS'
MONGO_USER
NEW_DYNAMIC_KEY
KEYS

export TOKENPANEL_CONFIG_DIR="$CONFIG_DIR"
unset MONGO_USER NEW_DYNAMIC_KEY || true

source "$ROOT/manager/lib/config.sh"

[ "$APP_YML" = "$CONFIG_DIR/generated/compose.yml" ] || {
  echo "FAIL: APP_YML did not select generated compose: $APP_YML" >&2
  exit 1
}
[ "$ENV_FILE" = "$CONFIG_DIR/generated/manager.env" ] || {
  echo "FAIL: ENV_FILE did not select generated manager.env: $ENV_FILE" >&2
  exit 1
}
[ "${MONGO_USER:-}" = "generated-user" ] || {
  echo "FAIL: generated manager.env was not loaded" >&2
  exit 1
}
[ "${NEW_DYNAMIC_KEY:-}" = "dynamic-ok" ] || {
  echo "FAIL: dynamic allowed-env-keys.txt was not honored" >&2
  exit 1
}

LEGACY_DIR="$TMP_DIR/legacy"
mkdir -p "$LEGACY_DIR"
: > "$LEGACY_DIR/app.yml"
: > "$LEGACY_DIR/.env"

(
  export TOKENPANEL_CONFIG_DIR="$LEGACY_DIR"
  unset APP_YML ENV_FILE
  source "$ROOT/manager/lib/config.sh"
  [ "$APP_YML" = "$LEGACY_DIR/app.yml" ] || exit 1
  [ "$ENV_FILE" = "$LEGACY_DIR/.env" ] || exit 1
)

echo "OK: generated config is preferred; legacy paths remain fallback"
