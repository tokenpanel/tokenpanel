#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/tokenpanel/tokenpanel"
BRANCH="stable"
INSTALL_DIR="${TOKENPANEL_INSTALL_DIR:-/opt/tokenpanel}"

cat <<'BANNER'
  ╔══════════════════════════════════════╗
  ║     TokenPanel Installer             ║
  ║     AI reseller gateway + admin      ║
  ╚══════════════════════════════════════╝
BANNER

echo
echo "This will install TokenPanel to: ${INSTALL_DIR}"
echo "Data will be stored in: /var/tokenpanel/shared"
echo

# ── 1. Root check ──
if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: Run as root (use sudo).'
  echo '  sudo curl -fsSL https://get.tokenpanel.sh | bash'
  exit 1
fi

# ── 2. OS + arch detection ──
OS="$(uname -s)"
ARCH="$(uname -m)"

[ "$OS" = "Linux" ] || { echo "ERROR: Only Linux supported. For macOS, use docker compose directly."; exit 1; }

case "$ARCH" in
  x86_64|amd64) ARCH='amd64' ;;
  aarch64|arm64) ARCH='arm64' ;;
  *) echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "✓ Detected: Linux/${ARCH}"

# ── 3. Install Docker if missing ──
if ! command -v docker >/dev/null 2>&1; then
  echo
  echo '→ Docker not found. Installing Docker...'
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  echo '✓ Docker installed'
else
  echo '✓ Docker already installed'
fi

docker info >/dev/null 2>&1 || { echo 'ERROR: Docker installed but not running. Start it: systemctl start docker'; exit 1; }

# ── 4. Install git if missing ──
if ! command -v git >/dev/null 2>&1; then
  echo '→ git not found. Installing git...'
  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1 || {
    yum install -y -q git >/dev/null 2>&1 || { echo 'ERROR: Could not install git. Install manually: apt-get install git'; exit 1; }
  }
  echo '✓ git installed'
fi

# ── 5. Install jq if missing ──
if ! command -v jq >/dev/null 2>&1; then
  echo '→ jq not found. Installing jq...'
  apt-get install -y -qq jq >/dev/null 2>&1 || yum install -y -q jq >/dev/null 2>&1 || true
fi

# ── 6. Install gettext (envsubst) if missing ──
if ! command -v envsubst >/dev/null 2>&1; then
  echo '→ envsubst not found. Installing gettext...'
  apt-get install -y -qq gettext >/dev/null 2>&1 || yum install -y -q gettext >/dev/null 2>&1 || true
fi

# ── 7. Clone or update the repo ──
echo
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ Existing install found at $INSTALL_DIR. Updating..."
  git -C "$INSTALL_DIR" fetch --prune origin

  # Detect local modifications, staged changes, or untracked files. A hard
  # reset to origin/$BRANCH would DISCARD all of them. This also protects the
  # plugin path: plugins shipped as files under the install tree show up here
  # (tracked edits / untracked files) and must not be silently nuked.
  tp_dirty=0
  if ! git -C "$INSTALL_DIR" diff --quiet HEAD 2>/dev/null; then tp_dirty=1; fi
  if ! git -C "$INSTALL_DIR" diff --cached --quiet HEAD 2>/dev/null; then tp_dirty=1; fi
  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null)" ]; then tp_dirty=1; fi

  if [ "$tp_dirty" -eq 1 ]; then
    echo
    echo "⚠  Local changes detected in $INSTALL_DIR:"
    git -C "$INSTALL_DIR" status --short 2>/dev/null | sed 's/^/    /' || true
    echo
    echo "A hard reset to origin/${BRANCH} would DISCARD all of the above."
    read -rp "Continue and discard local changes? [y/N] " tp_confirm
    case "$tp_confirm" in
      [yY]|[yY][eE][sS]) ;;
      *) echo "Aborted. Local changes preserved."; exit 0 ;;
    esac
  fi

  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  echo '✓ Repository updated'
else
  echo "→ Cloning TokenPanel to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  echo '✓ Repository cloned'
fi

# ── 8. Hand off to setup wizard ──
echo
echo '→ Starting setup wizard...'
exec "$INSTALL_DIR/manager/bin/tokenpanel-setup"