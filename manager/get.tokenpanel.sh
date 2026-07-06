#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/tokenpanel/tokenpanel"
BRANCH="main"
INSTALL_DIR="${TOKENPANEL_INSTALL_DIR:-/opt/tokenpanel}"

err() {
  echo "ERROR: $*" >&2
}

have_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

read_tty() {
  local __var="$1"
  local prompt="$2"
  if have_tty; then
    printf '%s' "$prompt" > /dev/tty
    IFS= read -r "$__var" < /dev/tty
  elif [ -t 0 ]; then
    IFS= read -r -p "$prompt" "$__var"
  else
    err "interactive input required but no TTY is available"
    err "run from an interactive shell: curl -fsSL https://raw.githubusercontent.com/tokenpanel/tokenpanel/refs/heads/main/manager/get.tokenpanel.sh -o get.tokenpanel.sh && sudo bash get.tokenpanel.sh"
    return 1
  fi
}

start_docker() {
  if command -v systemctl >/dev/null 2>&1 && systemctl list-system-units >/dev/null 2>&1; then
    systemctl enable --now docker.service 2>/dev/null || systemctl start docker.service 2>/dev/null || true
  elif command -v service >/dev/null 2>&1; then
    service docker start >/dev/null 2>&1 || true
  fi
}

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q "$@" >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q "$@" >/dev/null
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "$@" >/dev/null
  else
    return 1
  fi
}

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
  echo '  curl -fsSL https://get.tokenpanel.sh | sudo bash'
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
  start_docker
  echo '✓ Docker installed'
else
  echo '✓ Docker already installed'
fi

start_docker
docker info >/dev/null 2>&1 || { err 'Docker installed but not running. Start it: systemctl start docker'; exit 1; }

# ── 4. Install git if missing ──
if ! command -v git >/dev/null 2>&1; then
  echo '→ git not found. Installing git...'
  install_packages git || { err 'Could not install git. Install manually, then rerun installer.'; exit 1; }
  echo '✓ git installed'
fi

# ── 5. Install jq if missing ──
if ! command -v jq >/dev/null 2>&1; then
  echo '→ jq not found. Installing jq...'
  install_packages jq || echo '⚠ jq not installed; continuing with fallback parsers'
fi

# ── 6. Install gettext (envsubst) if missing ──
if ! command -v envsubst >/dev/null 2>&1; then
  echo '→ envsubst not found. Installing gettext...'
  install_packages gettext || { err 'Could not install gettext/envsubst. Install gettext, then rerun installer.'; exit 1; }
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
    read_tty tp_confirm "Continue and discard local changes? [y/N] " || exit 1
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
  if [ -e "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
    err "$INSTALL_DIR exists but is not a git checkout and is not empty"
    err "move it aside or set TOKENPANEL_INSTALL_DIR to a different path"
    exit 1
  fi
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  echo '✓ Repository cloned'
fi

# ── 8. Hand off to setup wizard ──
echo
echo '→ Starting setup wizard...'
if have_tty; then
  exec </dev/tty
fi
exec "$INSTALL_DIR/manager/bin/tokenpanel-setup"
