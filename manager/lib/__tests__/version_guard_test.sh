#!/usr/bin/env bash
# Integration test: only `tokenpanel update` changes the deployed version.
# `rebuild` and `tokenpanel-setup` refuse a checkout that differs from the
# deployed image (unless --force), and the installer leaves a live install
# alone instead of re-running setup over it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

BIN_DIR="$TMP_DIR/bin"
CONFIG_DIR="$TMP_DIR/config"
INSTALL_DIR="$TMP_DIR/install"
EVENTS="$TMP_DIR/events"
OUT="$TMP_DIR/out"
mkdir -p "$BIN_DIR" "$CONFIG_DIR"
touch "$CONFIG_DIR/app.yml"

cat >"$CONFIG_DIR/.env" <<'EOF'
MONGO_USER=user
MONGO_PASS=pass
MONGODB_DB=tokenpanel
DOMAIN=tokenpanel.example
ADMIN_EMAIL=admin@tokenpanel.example
JWT_SECRET=01234567890123456789012345678901
EOF

# Fake docker: deployed image carries FAKE_REVISION; builds fail so a run that
# passes the guard stops right after reaching `docker build`.
cat >"$BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$TEST_EVENTS"
case "$*" in
  build*) exit 1 ;;
  info*) exit 0 ;;
  "compose "*" images api "*) printf 'sha256:deployed\n'; exit 0 ;;
  *"org.opencontainers.image.revision"*) printf '%s\n' "${FAKE_REVISION:-}"; exit 0 ;;
  "image inspect "*) exit 0 ;;
esac
exit 0
EOF

cat >"$BIN_DIR/id" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-u" ]; then
  printf '0\n'
  exit 0
fi
exec /usr/bin/id "$@"
EOF
chmod +x "$BIN_DIR/docker" "$BIN_DIR/id"

export TEST_EVENTS="$EVENTS"
export PATH="$BIN_DIR:$PATH"
export TOKENPANEL_CONFIG_DIR="$CONFIG_DIR"
export TOKENPANEL_INSTALL_DIR="$INSTALL_DIR"
export TOKENPANEL_LOCK_FILE="$TMP_DIR/manager.lock"

fail() {
  echo "FAIL: $*" >&2
  cat "$OUT" >&2 || true
  exit 1
}

git init -q -b main "$INSTALL_DIR"
git -C "$INSTALL_DIR" commit -q --allow-empty -m "feat: deployed"
DEPLOYED="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
git -C "$INSTALL_DIR" commit -q --allow-empty -m "feat: newer checkout"
export FAKE_REVISION="$DEPLOYED"

run() {
  : >"$EVENTS"
  local rc=0
  "$@" >"$OUT" 2>&1 </dev/null || rc=$?
  return "$rc"
}

# ── rebuild ──
if run "$ROOT/manager/bin/tokenpanel" rebuild; then
  fail "rebuild of a checkout that differs from the deployed image succeeded"
fi
grep -q 'change versions with: tokenpanel update' "$OUT" || fail "rebuild refusal lacks guidance"
grep -q '^docker build' "$EVENTS" && fail "refused rebuild still built an image"
echo "OK: rebuild refuses a different checkout"

run "$ROOT/manager/bin/tokenpanel" rebuild --force || true
grep -q '^docker build' "$EVENTS" || fail "rebuild --force did not build"
echo "OK: rebuild --force builds the checkout"

git -C "$INSTALL_DIR" checkout -q --detach "$DEPLOYED"
run "$ROOT/manager/bin/tokenpanel" rebuild || true
grep -q '^docker build' "$EVENTS" || fail "rebuild of the deployed checkout was refused"
echo "OK: rebuild of the deployed version proceeds"
git -C "$INSTALL_DIR" checkout -q main

export FAKE_REVISION=""
run "$ROOT/manager/bin/tokenpanel" rebuild || true
grep -q '^docker build' "$EVENTS" || fail "rebuild with unknown deployed version was refused"
echo "OK: unknown deployed version does not block rebuild"
export FAKE_REVISION="$DEPLOYED"

# ── tokenpanel-setup ──
if run "$ROOT/manager/bin/tokenpanel-setup"; then
  fail "setup over a different checkout succeeded"
fi
grep -q 'setup refused' "$OUT" || fail "setup refusal not reported"
grep -q '^docker build' "$EVENTS" && fail "refused setup still built an image"
echo "OK: setup refuses a different checkout"

# ── installer over a live install ──
before="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
run bash "$ROOT/manager/install.sh" || fail "installer over live install exited non-zero"
grep -q 'already installed' "$OUT" || fail "installer did not report existing install"
grep -q 'sudo tokenpanel update' "$OUT" || fail "installer did not point to tokenpanel update"
[ "$(git -C "$INSTALL_DIR" rev-parse HEAD)" = "$before" ] || fail "installer moved the live checkout"
grep -q 'Starting setup wizard' "$OUT" && fail "installer re-ran setup over a live install"
echo "OK: installer leaves a live install to tokenpanel update"

echo "ALL PASS"
