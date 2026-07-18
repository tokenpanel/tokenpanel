#!/usr/bin/env bash
# Integration test: update refreshes and invokes the target manager before the
# old API can be stopped for backup.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BIN_DIR="$TMP_DIR/bin"
CONFIG_DIR="$TMP_DIR/config"
INSTALL_DIR="$TMP_DIR/install"
EVENTS="$TMP_DIR/events"
mkdir -p "$BIN_DIR" "$CONFIG_DIR" "$INSTALL_DIR/manager/bin"
touch "$CONFIG_DIR/app.yml" "$EVENTS"

cat >"$CONFIG_DIR/.env" <<'EOF'
MONGO_USER=user
MONGO_PASS=pass
MONGODB_DB=tokenpanel
DOMAIN=tokenpanel.example
ADMIN_EMAIL=admin@tokenpanel.example
JWT_SECRET=01234567890123456789012345678901
EOF

cat >"$BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$TEST_EVENTS"
if [ "${1:-}" = "info" ]; then
  exit 0
fi
if [[ "$*" == *" mongosh "* ]]; then
  printf 'true\n'
fi
exit 0
EOF

cat >"$BIN_DIR/git" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *describe*) printf 'old-source\n' ;;
  *fetch*) printf 'fetch\n' >>"$TEST_EVENTS" ;;
  *checkout*)
    printf 'checkout\n' >>"$TEST_EVENTS"
    cat >"$TEST_INSTALL_DIR/manager/bin/tokenpanel" <<'TARGET'
#!/usr/bin/env bash
set -euo pipefail
lock_state=unblocked
if ! flock -n "$TEST_LOCK_FILE" -c true 2>/dev/null; then
  lock_state=blocked
fi
inherited_fd="${TOKENPANEL_UPDATE_LOCK_FD:-}"
fd_state=missing
if [[ "$inherited_fd" =~ ^[0-9]+$ ]] && [ -e "/proc/$$/fd/$inherited_fd" ]; then
  fd_state=present
fi
printf 'child args=%s bootstrapped=%s from=%s lock_fd=%s lock=%s\n' \
  "$*" \
  "${TOKENPANEL_UPDATE_BOOTSTRAPPED:-}" \
  "${TOKENPANEL_UPDATE_FROM_VERSION:-}" \
  "$fd_state" \
  "$lock_state" >>"$TEST_EVENTS"
TARGET
    chmod +x "$TEST_INSTALL_DIR/manager/bin/tokenpanel"
    ;;
esac
exit 0
EOF

cat >"$BIN_DIR/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1M-blocks Used Available Use%% Mounted on\n'
printf 'fake 10000 1 9999 1%% /var\n'
EOF

cat >"$BIN_DIR/id" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-u" ]; then
  printf '0\n'
  exit 0
fi
exec /usr/bin/id "$@"
EOF

cat >"$INSTALL_DIR/manager/bin/tokenpanel" <<'EOF'
#!/usr/bin/env bash
printf 'old-manager-ran\n' >>"$TEST_EVENTS"
exit 77
EOF

chmod +x \
  "$BIN_DIR/docker" \
  "$BIN_DIR/git" \
  "$BIN_DIR/df" \
  "$BIN_DIR/id" \
  "$INSTALL_DIR/manager/bin/tokenpanel"

export TEST_EVENTS="$EVENTS"
export TEST_INSTALL_DIR="$INSTALL_DIR"
export TEST_LOCK_FILE="$TMP_DIR/manager.lock"
export PATH="$BIN_DIR:$PATH"
export TOKENPANEL_CONFIG_DIR="$CONFIG_DIR"
export TOKENPANEL_INSTALL_DIR="$INSTALL_DIR"
export TOKENPANEL_LOCK_FILE="$TMP_DIR/manager.lock"

"$ROOT/manager/bin/tokenpanel" update >/dev/null

fetch_line="$(grep -n '^fetch$' "$EVENTS" | cut -d: -f1)"
checkout_line="$(grep -n '^checkout$' "$EVENTS" | cut -d: -f1)"
child_line="$(grep -n '^child ' "$EVENTS" | cut -d: -f1)"

[ -n "$fetch_line" ] || { echo "FAIL: target manager was not fetched" >&2; exit 1; }
[ -n "$checkout_line" ] || { echo "FAIL: target manager was not checked out" >&2; exit 1; }
[ -n "$child_line" ] || { echo "FAIL: target manager was not invoked" >&2; exit 1; }
[ "$fetch_line" -lt "$checkout_line" ] && [ "$checkout_line" -lt "$child_line" ] \
  || { echo "FAIL: manager bootstrap order is wrong" >&2; exit 1; }

grep -q 'child args=update bootstrapped=1 from=old-source lock_fd=present lock=blocked' "$EVENTS" \
  || {
    echo "FAIL: refreshed manager did not receive bootstrap context: $(tail -n 1 "$EVENTS")" >&2
    exit 1
  }
if grep -q '^old-manager-ran$' "$EVENTS"; then
  echo "FAIL: source manager ran instead of fetched target manager" >&2
  exit 1
fi
if grep -q 'docker .* stop .*api' "$EVENTS"; then
  echo "FAIL: old API stopped before target manager took control" >&2
  exit 1
fi

echo "OK: target manager takes control before backup"
