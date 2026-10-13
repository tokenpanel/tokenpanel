#!/usr/bin/env bash
# Integration test: `tokenpanel update` follows release tags with real git
# repositories and a fake docker. Covers the legacy handoff (managers that
# predate releases check out origin/main and run its manager without a
# target), shallow installs, deployed-version detection from image labels and
# legacy image tags, no-op and downgrade gates, and the pre-release fallback
# to origin/main.
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

# Fake docker: the deployed image is FAKE_IMAGE_ID with an optional revision
# label (FAKE_REVISION) and repo tags (FAKE_REPO_TAGS, newline separated).
cat >"$BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$TEST_EVENTS"
case "$*" in
  info*) exit 0 ;;
  *" mongosh "*) printf 'true\n'; exit 0 ;;
  "compose "*" images api "*)
    [ -n "${FAKE_IMAGE_ID:-}" ] && printf '%s\n' "$FAKE_IMAGE_ID"
    exit 0 ;;
  "image inspect --format {{.Id}} tokenpanel/app:current")
    [ -n "${FAKE_IMAGE_ID:-}" ] || exit 1
    printf '%s\n' "$FAKE_IMAGE_ID"; exit 0 ;;
  *"org.opencontainers.image.revision"*)
    [ -n "${FAKE_IMAGE_ID:-}" ] || exit 1
    printf '%s\n' "${FAKE_REVISION:-}"; exit 0 ;;
  *"RepoTags"*)
    [ -n "${FAKE_IMAGE_ID:-}" ] || exit 1
    printf '%s\n' "${FAKE_REPO_TAGS:-}"; exit 0 ;;
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
chmod +x "$BIN_DIR/docker" "$BIN_DIR/df" "$BIN_DIR/id"

export TEST_EVENTS="$EVENTS"
export PATH="$BIN_DIR:$PATH"
export TOKENPANEL_CONFIG_DIR="$CONFIG_DIR"
export TOKENPANEL_LOCK_FILE="$TMP_DIR/manager.lock"
export TEST_LOCK_FILE="$TMP_DIR/manager.lock"

fail() {
  echo "FAIL: $*" >&2
  echo "--- events" >&2
  cat "$EVENTS" >&2 || true
  echo "--- output" >&2
  cat "$OUT" >&2 || true
  exit 1
}

# A stub manager committed at a release: records how it was invoked.
write_stub_manager() {
  local work="$1" name="$2"
  rm -rf "$work/manager"
  mkdir -p "$work/manager/bin"
  cat >"$work/manager/bin/tokenpanel" <<STUB
#!/usr/bin/env bash
fd_state=missing
if [[ "\${TOKENPANEL_UPDATE_LOCK_FD:-}" =~ ^[0-9]+\$ ]] && [ -e "/proc/\$\$/fd/\${TOKENPANEL_UPDATE_LOCK_FD}" ]; then
  fd_state=present
fi
lock_state=unblocked
if ! flock -n "\$TEST_LOCK_FILE" -c true 2>/dev/null; then
  lock_state=blocked
fi
printf 'child=%s args=%s bootstrapped=%s channel=%s fetched=%s hops=%s from=%s lock_fd=%s lock=%s\n' \\
  "$name" "\$*" "\${TOKENPANEL_UPDATE_BOOTSTRAPPED:-}" "\${TOKENPANEL_UPDATE_CHANNEL:-}" \\
  "\${TOKENPANEL_UPDATE_REFS_FETCHED:-}" "\${TOKENPANEL_UPDATE_HOPS:-}" \\
  "\${TOKENPANEL_UPDATE_FROM_VERSION:-}" "\$fd_state" "\$lock_state" >>"\$TEST_EVENTS"
STUB
  chmod +x "$work/manager/bin/tokenpanel"
}

commit_all() {
  local work="$1" msg="$2"
  git -C "$work" add -A
  git -C "$work" commit -q -m "$msg"
  git -C "$work" rev-parse HEAD
}

# origin: A (old deployed build) → B tagged v0.1.0 → C main tip carrying the
# real manager from this working tree (what legacy managers execute).
ORIGIN="$TMP_DIR/origin.git"
WORK="$TMP_DIR/work"
git init -q --bare -b main "$ORIGIN"
git init -q -b main "$WORK"
git -C "$WORK" remote add origin "$ORIGIN"
write_stub_manager "$WORK" A
SHA_A="$(commit_all "$WORK" "feat: old build")"
write_stub_manager "$WORK" B
SHA_B="$(commit_all "$WORK" "feat: first release")"
git -C "$WORK" tag v0.1.0
rm -rf "$WORK/manager"
cp -rf "$ROOT/manager" "$WORK/manager"
SHA_C="$(commit_all "$WORK" "feat: unreleased work")"
# A prerelease and a stable tag off main must both be ignored by the channel.
git -C "$WORK" checkout -q -b side "$SHA_B"
write_stub_manager "$WORK" SIDE
SHA_SIDE="$(commit_all "$WORK" "feat: side branch")"
git -C "$WORK" tag v0.2.0-rc.1
git -C "$WORK" tag v9.0.0
git -C "$WORK" checkout -q main
git -C "$WORK" push -q origin main side --tags

reset_install() {
  local ref="$1"
  shift
  INSTALL_DIR="$TMP_DIR/install"
  rm -rf "$INSTALL_DIR"
  git clone -q "$@" "file://$ORIGIN" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" checkout -q --detach "$ref"
  export TOKENPANEL_INSTALL_DIR="$INSTALL_DIR"
  : >"$EVENTS"
  : >"$OUT"
}

run_update() {
  local rc=0
  "$@" >"$OUT" 2>&1 || rc=$?
  return "$rc"
}

head_of_install() {
  git -C "$INSTALL_DIR" rev-parse HEAD
}

# ── latest_stable_tag ordering ──
(
  source "$ROOT/manager/lib/release.sh"
  ORDER="$TMP_DIR/order"
  git init -q -b main "$ORDER"
  for tag in v0.9.0 v0.10.0 v0.10.1-rc.1 v0.2.5 release-1 v1.0; do
    git -C "$ORDER" commit -q --allow-empty -m "chore: $tag"
    git -C "$ORDER" tag "$tag"
  done
  git -C "$ORDER" update-ref refs/remotes/origin/main HEAD
  got="$(latest_stable_tag "$ORDER")"
  [ "$got" = "v0.10.0" ] || { echo "FAIL: expected v0.10.0, got '$got'" >&2; exit 1; }
)
got="$(source "$ROOT/manager/lib/release.sh"; latest_stable_tag "$WORK")"
[ "$got" = "v0.1.0" ] || fail "tags off main or prerelease were selected: '$got'"
echo "OK: latest stable tag is highest vX.Y.Z on main"

# ── Legacy handoff from a shallow install ──
# An old manager fetched, checked out origin/main (C) and ran C's manager
# bootstrapped with no target while holding the lock.
reset_install main --depth 1 --branch main
export FAKE_IMAGE_ID=sha256:aaa FAKE_REVISION="$SHA_A" FAKE_REPO_TAGS=""
exec {held_fd}>"$TEST_LOCK_FILE"
flock -n "$held_fd"
run_update env TOKENPANEL_UPDATE_BOOTSTRAPPED=1 TOKENPANEL_UPDATE_LOCK_FD="$held_fd" \
  TOKENPANEL_UPDATE_FROM_VERSION=legacy-describe \
  "$INSTALL_DIR/manager/bin/tokenpanel" update || fail "legacy handoff exited non-zero"
exec {held_fd}>&-
[ "$(git -C "$INSTALL_DIR" rev-parse --is-shallow-repository)" = "false" ] \
  || fail "shallow install was not converted"
[ "$(head_of_install)" = "$SHA_B" ] || fail "legacy handoff did not check out v0.1.0"
grep -q "child=B args=update v0.1.0 bootstrapped=1 channel=stable fetched=1 hops=1 from=${SHA_A:0:7}" "$EVENTS" \
  || fail "legacy handoff did not reach the release manager with context"
grep -q 'lock_fd=present lock=blocked' "$EVENTS" || fail "lock not carried through legacy handoff"
grep -q 'docker .* stop' "$EVENTS" && fail "api touched before release manager took control"
echo "OK: legacy manager reaches latest stable release"

# ── New manager, no version: resolves the release itself ──
reset_install "$SHA_A"
run_update "$ROOT/manager/bin/tokenpanel" update || fail "stable update exited non-zero"
[ "$(head_of_install)" = "$SHA_B" ] || fail "stable update did not check out v0.1.0"
grep -q 'child=B args=update v0.1.0 bootstrapped=1 channel=stable fetched=1 hops=1' "$EVENTS" \
  || fail "stable update did not hand off to v0.1.0 manager"
echo "OK: stable update targets latest release"

# ── Legacy image without labels: commit from its describe tag ──
reset_install "$SHA_A"
export FAKE_REVISION="" FAKE_REPO_TAGS=$'tokenpanel/app:current\ntokenpanel/app:'"${SHA_A:0:7}"
run_update "$ROOT/manager/bin/tokenpanel" update || fail "legacy-image update exited non-zero"
grep -q "child=B args=update v0.1.0 .* from=${SHA_A:0:7}" "$EVENTS" \
  || fail "legacy image commit not detected"
echo "OK: unlabelled legacy image resolved from its tag"

# ── Already on latest: no-op, checkout moved back to the deployed commit ──
reset_install "$SHA_C"
export FAKE_REVISION="" FAKE_REPO_TAGS=$'tokenpanel/app:v0.1.0\ntokenpanel/app:current'
run_update "$ROOT/manager/bin/tokenpanel" update || fail "no-op update exited non-zero"
grep -q '^child=' "$EVENTS" && fail "no-op update invoked a target manager"
grep -q 'already up to date' "$OUT" || fail "no-op update did not report up to date"
[ "$(head_of_install)" = "$SHA_B" ] || fail "no-op did not restore deployed checkout"
echo "OK: up-to-date install is a no-op"

# ── Rollback state: checkout on target, image on old build → still updates ──
reset_install "$SHA_B"
export FAKE_REVISION="$SHA_A" FAKE_REPO_TAGS=""
run_update "$ROOT/manager/bin/tokenpanel" update || fail "retry after rollback exited non-zero"
grep -q 'child=B args=update v0.1.0 bootstrapped=1 channel=stable' "$EVENTS" \
  || fail "retry after rollback did not update (checkout mistaken for deployed)"
echo "OK: retry after rollback is not mistaken for up to date"

# ── Deployed build ahead of the latest release ──
reset_install "$SHA_C"
export FAKE_REVISION="$SHA_C"
run_update "$ROOT/manager/bin/tokenpanel" update || fail "ahead-of-release update exited non-zero"
grep -q '^child=' "$EVENTS" && fail "ahead-of-release update downgraded"
grep -q 'newer than the latest release v0.1.0' "$OUT" || fail "ahead-of-release not reported"
[ "$(head_of_install)" = "$SHA_C" ] || fail "ahead-of-release moved checkout"
echo "OK: build newer than latest release is left alone"

# ── Explicit downgrade refused ──
reset_install "$SHA_C"
if run_update "$ROOT/manager/bin/tokenpanel" update v0.1.0; then
  fail "explicit downgrade was allowed"
fi
grep -q 'refusing downgrade' "$OUT" || fail "downgrade refusal not reported"
grep -q '^child=' "$EVENTS" && fail "downgrade invoked a target manager"
echo "OK: explicit downgrade refused"

# ── Explicit prerelease upgrade keeps explicit channel ──
reset_install "$SHA_B"
export FAKE_REVISION="$SHA_B"
run_update "$ROOT/manager/bin/tokenpanel" update v0.2.0-rc.1 || fail "explicit prerelease update failed"
[ "$(head_of_install)" = "$SHA_SIDE" ] || fail "explicit prerelease not checked out"
grep -q 'child=SIDE args=update v0.2.0-rc.1 bootstrapped=1 channel=explicit' "$EVENTS" \
  || fail "explicit prerelease did not hand off with explicit channel"
echo "OK: explicit prerelease update hands off"

# ── Unknown version ──
reset_install "$SHA_B"
if run_update "$ROOT/manager/bin/tokenpanel" update v7.7.7; then
  fail "unknown version accepted"
fi
grep -q "unknown version 'v7.7.7'" "$OUT" || fail "unknown version not reported"
[ "$(head_of_install)" = "$SHA_B" ] || fail "unknown version moved checkout"
echo "OK: unknown version aborts without changes"

# ── No deployed image (unknown): proceeds with a warning ──
reset_install "$SHA_A"
unset FAKE_IMAGE_ID
run_update "$ROOT/manager/bin/tokenpanel" update || fail "unknown deployed version blocked update"
grep -q 'child=B args=update v0.1.0' "$EVENTS" || fail "unknown deployed version did not update"
echo "OK: unknown deployed version does not block updates"

# ── No releases yet: origin/main, as before releases existed ──
NOREL="$TMP_DIR/norel.git"
NOREL_WORK="$TMP_DIR/norel-work"
git init -q --bare -b main "$NOREL"
git init -q -b main "$NOREL_WORK"
git -C "$NOREL_WORK" remote add origin "$NOREL"
write_stub_manager "$NOREL_WORK" OLD
NOREL_A="$(commit_all "$NOREL_WORK" "feat: old")"
write_stub_manager "$NOREL_WORK" MAIN
NOREL_B="$(commit_all "$NOREL_WORK" "feat: main tip")"
git -C "$NOREL_WORK" push -q origin main
INSTALL_DIR="$TMP_DIR/install"
rm -rf "$INSTALL_DIR"
git clone -q "file://$NOREL" "$INSTALL_DIR"
git -C "$INSTALL_DIR" checkout -q --detach "$NOREL_A"
: >"$EVENTS"
export FAKE_IMAGE_ID=sha256:aaa FAKE_REVISION="$NOREL_A"
run_update "$ROOT/manager/bin/tokenpanel" update || fail "pre-release update failed"
[ "$(head_of_install)" = "$NOREL_B" ] || fail "pre-release update did not use origin/main"
grep -q 'child=MAIN args=update bootstrapped=1 channel=stable' "$EVENTS" \
  || fail "pre-release update did not hand off to main manager"
echo "OK: no releases falls back to origin/main"

echo "ALL PASS"
