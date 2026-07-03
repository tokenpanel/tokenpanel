#!/usr/bin/env bash
set -euo pipefail

# Resolve our own directory with a name config.sh will not clobber (config.sh
# reassigns SCRIPT_DIR/MANAGER_DIR to the lib dir).
UNINSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${UNINSTALL_DIR}/lib/config.sh"
source "${UNINSTALL_DIR}/lib/output.sh"
source "${UNINSTALL_DIR}/lib/systemd.sh"

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"

echo -e "${RED}${BOLD}⚠  TOKENPANEL UNINSTALL  ⚠${NC}"
echo
echo "This will PERMANENTLY REMOVE TokenPanel:"
echo "  - Stop and remove containers (and their volumes)"
echo "  - Delete ${INSTALL_DIR} (code + manager)"
echo "  - Delete ${CONFIG_DIR} (config)"
echo "  - Delete ${LOG_DIR} (logs)"
echo "  - DELETE ${DATA_DIR} (ALL DATA — MongoDB, backups, certs)"
echo
echo -e "${RED}This action is IRREVERSIBLE. No recovery is possible.${NC}"
echo

# ── Safety: refuse to wipe paths outside the destructive allowlist ──
for p in "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"; do
  if ! tp_safe_destructive_path "$p"; then
    die "refusing to remove unsafe path: '$p' (must be under /opt, /var, /etc, /srv, or /usr/local — not a bare root). Aborting."
  fi
done

# ── Double confirmation ──
read -rp "Type DELETE to confirm: " confirm1
[ "$confirm1" = "DELETE" ] || { info "Aborted."; exit 0; }
echo
echo "To confirm, type the data directory exactly: ${DATA_DIR}"
read -rp "> " confirm2
[ "$confirm2" = "$DATA_DIR" ] || { err "data directory mismatch — aborting"; exit 1; }

echo
warn "uninstalling in 5 seconds... (Ctrl+C to cancel)"
sleep 5

# ── Remove ──
step "uninstall" "stopping systemd service..."
systemctl stop tokenpanel 2>/dev/null || true
uninstall_systemd_service || true

step "uninstall" "stopping + removing containers (volumes too)..."
docker compose -f "$APP_YML" down -v --remove-orphans 2>/dev/null || true

step "uninstall" "removing install dir..."
rm -rf "${INSTALL_DIR:?}"

step "uninstall" "removing config dir..."
rm -rf "${CONFIG_DIR:?}"

step "uninstall" "removing log dir..."
rm -rf "${LOG_DIR:?}"

step "uninstall" "removing data dir (ALL DATA)..."
rm -rf "${DATA_DIR:?}"

step "uninstall" "removing CLI symlinks..."
rm -f /usr/local/bin/tokenpanel /usr/local/bin/tokenpanel-setup

echo
ok "TokenPanel fully removed."