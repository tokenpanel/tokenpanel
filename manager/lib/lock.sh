#!/usr/bin/env bash
# Cross-command exclusive lock for mutating tokenpanel operations.
#
# Prevents concurrent update / backup / restore / migrate / rebuild / etc.
# from interleaving (API stop/start, mongodump, drop+rename swap, migrations).
#
# Implementation: util-linux flock(1) on MANAGER_LOCK_FILE. Kernel releases
# the lock when the holding process exits (no stale-PID problem). Same-process
# re-entry is a no-op so update → create_backup and restore → create_backup
# do not self-deadlock.
#
# Override path: TOKENPANEL_LOCK_FILE. Skip (tests only): TOKENPANEL_SKIP_MANAGER_LOCK=1.

# Prefer CONFIG_DIR so reset (which wipes DATA_DIR) cannot drop the lock inode
# out from under a held flock and allow a concurrent command onto a new file.
# CONFIG_DIR may be unset when unit tests source backup.sh without config.sh —
# default matches production layout. Override with TOKENPANEL_LOCK_FILE.
MANAGER_LOCK_FILE="${TOKENPANEL_LOCK_FILE:-${CONFIG_DIR:-/etc/tokenpanel}/manager.lock}"

# Allocated by bash's dynamic-FD redirection when the lock is acquired. Do not
# take this value from the environment: the old eval-based redirection made an
# untrusted MANAGER_LOCK_FD value executable in this root-owned script.
MANAGER_LOCK_FD=""
MANAGER_LOCK_HELD="${MANAGER_LOCK_HELD:-0}"

# Acquire exclusive manager lock for $1 (command name for diagnostics).
# Returns 0 if acquired or already held by this process; 1 if busy / unavailable.
acquire_manager_lock() {
  local cmd="${1:-tokenpanel}"

  if [ "${TOKENPANEL_SKIP_MANAGER_LOCK:-0}" = "1" ]; then
    return 0
  fi

  if [ "${MANAGER_LOCK_HELD:-0}" -eq 1 ]; then
    return 0
  fi

  if ! command -v flock >/dev/null 2>&1; then
    err "flock not found — install util-linux (required for safe concurrent ops)"
    return 1
  fi

  # Re-resolve each call so TOKENPANEL_LOCK_FILE overrides still apply after
  # lock.sh was sourced (tests set the env var after source).
  local lock_file
  lock_file="${TOKENPANEL_LOCK_FILE:-${CONFIG_DIR:-/etc/tokenpanel}/manager.lock}"
  MANAGER_LOCK_FILE="$lock_file"

  local lock_dir
  lock_dir="$(dirname "$lock_file")"
  if ! mkdir -p "$lock_dir" 2>/dev/null; then
    err "cannot create lock directory: $lock_dir"
    return 1
  fi

  # Open lock file on a shell-allocated FD, then flock it non-blocking. Bash
  # validates the descriptor itself; no user-controlled value is evaluated.
  local lock_fd
  if ! exec {lock_fd}>"$lock_file"; then
    err "cannot open manager lock: $lock_file"
    return 1
  fi
  MANAGER_LOCK_FD="$lock_fd"
  if ! flock -n "${MANAGER_LOCK_FD}"; then
    local holder=""
    holder="$(tr '\n' ' ' <"$lock_file" 2>/dev/null | sed 's/ *$//')" || true
    err "another tokenpanel command is already running"
    err "lock: $lock_file"
    if [ -n "$holder" ]; then
      err "holder: $holder"
    fi
    err "wait for it to finish (or kill the holder PID if it is truly stuck)"
    exec {MANAGER_LOCK_FD}>&- 2>/dev/null || true
    MANAGER_LOCK_FD=""
    return 1
  fi

  # Metadata for operators; truncate via path while FD holds the flock on inode.
  printf 'pid=%s cmd=%s started=%s\n' \
    "$$" "$cmd" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$lock_file" || true

  MANAGER_LOCK_HELD=1
  return 0
}

# Adopt a lock FD inherited from a parent manager process across exec. The FD
# must still be open, refer to the configured lock file, and carry/acquire its
# flock. This prevents a stale bootstrap flag from bypassing serialization.
adopt_manager_lock() {
  local inherited_fd="${1:-}"
  local lock_file="${TOKENPANEL_LOCK_FILE:-${CONFIG_DIR:-/etc/tokenpanel}/manager.lock}"

  case "$inherited_fd" in
    ''|*[!0-9]*)
      err "invalid inherited manager lock"
      return 1
      ;;
  esac

  if [ ! -e "/proc/$$/fd/${inherited_fd}" ] \
    || [ ! "$lock_file" -ef "/proc/$$/fd/${inherited_fd}" ]; then
    err "inherited manager lock does not match $lock_file"
    return 1
  fi

  if ! flock -n "$inherited_fd"; then
    err "inherited manager lock is not held"
    return 1
  fi

  MANAGER_LOCK_FILE="$lock_file"
  MANAGER_LOCK_FD="$inherited_fd"
  MANAGER_LOCK_HELD=1
  return 0
}

# Explicit release (mainly for tests). Normal CLI holds until process exit.
release_manager_lock() {
  if [ "${TOKENPANEL_SKIP_MANAGER_LOCK:-0}" = "1" ]; then
    MANAGER_LOCK_HELD=0
    return 0
  fi
  if [ "${MANAGER_LOCK_HELD:-0}" -ne 1 ]; then
    return 0
  fi
  flock -u "${MANAGER_LOCK_FD}" 2>/dev/null || true
  exec {MANAGER_LOCK_FD}>&- 2>/dev/null || true
  MANAGER_LOCK_FD=""
  MANAGER_LOCK_HELD=0
  return 0
}
