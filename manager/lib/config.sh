#!/usr/bin/env bash
# Shared configuration — sourced by all manager scripts.
# Resolves installation paths. Most paths can be overridden by setting
# TOKENPANEL_*_DIR in /etc/tokenpanel/manager.env (or the shell env).
# CONFIG_DIR is resolved from the shell env first (it locates manager.env),
# so it can only be overridden via TOKENPANEL_CONFIG_DIR in the shell env.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# URI-encoding helpers (uri_encode) — needed by _ensure_uri_creds below to
# derive MONGO_USER_URI / MONGO_PASS_URI from the raw credentials.
source "${SCRIPT_DIR}/encode.sh"

# CONFIG_DIR is resolved first (from the shell env) so manager.env — which may
# override the remaining installation paths — can be located and sourced before
# those paths are computed.
CONFIG_DIR="${TOKENPANEL_CONFIG_DIR:-/etc/tokenpanel}"

# Source operator-controlled manager.env BEFORE computing the remaining paths.
# It is auto-exported (set -a) so TOKENPANEL_*_DIR values it sets take effect
# when INSTALL_DIR / DATA_DIR / LOG_DIR are resolved below. (Previously this
# was sourced after all paths were already frozen, so its overrides silently
# had no effect — contradicting the header comment.)
if [ -f "${CONFIG_DIR}/manager.env" ]; then
  set -a
  source "${CONFIG_DIR}/manager.env"
  set +a
fi

# Remaining paths — TOKENPANEL_* from the shell env OR manager.env now apply.
INSTALL_DIR="${TOKENPANEL_INSTALL_DIR:-/opt/tokenpanel}"
DATA_DIR="${TOKENPANEL_DATA_DIR:-/var/tokenpanel/shared}"
LOG_DIR="${TOKENPANEL_LOG_DIR:-/var/tokenpanel/logs}"
BACKUP_DIR="${DATA_DIR}/backups"

APP_YML="${CONFIG_DIR}/app.yml"
ENV_FILE="${CONFIG_DIR}/.env"
TEMPLATE_DIR="${MANAGER_DIR}/templates"

# Keys that may legally appear in .env and be exported into the manager's
# environment. Anything else in .env is silently ignored — this prevents
# arbitrary command execution from a tampered .env (which is sourced as root).
ALLOWED_ENV_KEYS=(
  MONGO_USER MONGO_PASS MONGO_USER_URI MONGO_PASS_URI
  MONGODB_DB DOMAIN ADMIN_EMAIL JWT_SECRET TZ API_PORT
  SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM
)

# Parse .env as strict KEY=VALUE lines and export only allowlisted keys.
# Never `source` .env — a malicious value like $(rm -rf /) would execute.
load_env_safe() {
  local env_file="$1"
  [ -f "$env_file" ] || return 0
  local key val line
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and blank lines.
    case "$line" in \#* | '') continue ;; esac
    # Must contain '='.
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    # Key must be a valid identifier (letter/underscore start, alnum/underscore).
    case "$key" in
      '' | [0-9]* | *[!A-Za-z0-9_]*) continue ;;
    esac
    # Only allow known keys.
    local found=0
    for k in "${ALLOWED_ENV_KEYS[@]}"; do
      [ "$key" = "$k" ] && { found=1; break; }
    done
    [ "$found" -eq 1 ] || continue
    # Strip surrounding double or single quotes.
    val="${val#\"}"; val="${val%\"}"
    val="${val#\'}"; val="${val%\'}"
    export "$key=$val"
  done < "$env_file"
}

load_env_safe "$ENV_FILE"
# manager.env was sourced above (before path resolution) so its TOKENPANEL_*_DIR
# overrides take effect. Secrets remain authoritative from .env via
# load_env_safe, which runs here (after manager.env).

# Ensure URI-encoded Mongo credentials are available. Fresh setups write
# MONGO_USER_URI / MONGO_PASS_URI into .env, but older .env files (written
# before encoded vars were added) may omit them. Derive from the raw values
# so every manager command — and Compose variable interpolation (which reads
# the shell environment) — gets valid encoded credentials without requiring a
# re-run of tokenpanel-setup.
_ensure_uri_creds() {
  # Guard with ${VAR:-} so this is safe to call before the credentials exist
  # (e.g. during the first-run setup wizard, when .env has not been written yet
  # and MONGO_USER/MONGO_PASS are unset). Under `set -u` an unguarded reference
  # to ${MONGO_USER} inside the command substitution spews "unbound variable"
  # noise to stderr. Only derive when the raw value is set; if the encoded
  # variant is already present in .env (MONGO_USER_URI) the `:=` default is a
  # no-op.
  if [ -n "${MONGO_USER:-}" ]; then
    : "${MONGO_USER_URI:=$(uri_encode "${MONGO_USER}")}"
  fi
  if [ -n "${MONGO_PASS:-}" ]; then
    : "${MONGO_PASS_URI:=$(uri_encode "${MONGO_PASS}")}"
  fi
  export MONGO_USER_URI MONGO_PASS_URI
}
_ensure_uri_creds

# ── Destructive-path safety gate ──
# Refuse to delete paths outside a known-safe prefix allowlist. Guards against
# misconfigured TOKENPANEL_* env vars (e.g. TOKENPANEL_DATA_DIR=/) that would
# otherwise cause catastrophic data loss during reset/uninstall. Returns 0
# (safe) / 1 (unsafe). Used by cmd_reset and uninstall.sh.
tp_safe_destructive_path() {
  local p="${1:-}"
  # Strip trailing slashes (but keep "/" as "/").
  while [ "${p%/}" != "$p" ] && [ "$p" != "/" ]; do p="${p%/}"; done

  # Reject empty, relative, or root.
  case "$p" in
    ''|/) return 1 ;;
  esac
  case "$p" in
    /*) : ;;
    *) return 1 ;;
  esac

  # Reject bare mount-point-ish dirs — only allow paths UNDER a prefix.
  case "$p" in
    /bin|/sbin|/boot|/dev|/etc|/lib|/lib64|/opt|/proc|/root|/run|/srv|/sys|/tmp|/usr|/usr/local|/var|/home) return 1 ;;
  esac

  # Allow only under these prefixes.
  case "$p" in
    /opt/*|/var/*|/etc/*|/srv/*|/usr/local/*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── MongoDB database name guard ──
# MONGODB_DB is interpolated raw into the mongodb:// URI path in the compose
# templates and used as MONGO_INITDB_DATABASE. A name with URI-breaking chars
# (/, ?, :, @, space, …) silently breaks the connection string or misroutes
# writes. tokenpanel-setup enforces the strict charset at entry time; this guard
# is defense-in-depth for a tampered .env, warning loudly on every command.
# Non-fatal (returns 0) so it never blocks tokenpanel-setup itself from fixing
# a bad value, and so read-only commands still run. Uses printf directly because
# output.sh (which defines err/warn) is sourced AFTER config.sh.
tp_validate_mongodb_db() {
  local db="${MONGODB_DB:-}"
  [ -n "$db" ] || return 0   # not configured yet (first-run setup)
  if ! [[ "$db" =~ ^[A-Za-z0-9_-]+$ ]] || [ "${#db}" -gt 64 ]; then
    printf 'tokenpanel: MONGODB_DB is invalid (allowed [A-Za-z0-9_-], max 64 chars). Re-run tokenpanel-setup.\n' >&2
    return 0
  fi
  case "$db" in
    admin|local|config)
      printf 'tokenpanel: MONGODB_DB=%s is a reserved MongoDB system database. Re-run tokenpanel-setup.\n' "$db" >&2
      return 0
      ;;
  esac
  return 0
}
tp_validate_mongodb_db
