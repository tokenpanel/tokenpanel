#!/usr/bin/env bash
# Systemd service management — sourced by bin/tokenpanel-setup and bin/tokenpanel.
#
# The unit delegates to `tokenpanel start|stop|restart` (not raw docker compose)
# so boot/reboot apply post-deploy migrations the same way as the CLI.

install_systemd_service() {
  source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/output.sh"
  source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/config.sh"

  step "systemd" "installing service..."

  local unit_file="/etc/systemd/system/tokenpanel.service"
  export INSTALL_DIR CONFIG_DIR

  # Whitelist: only expand install/config paths. Secrets and unrelated env
  # must never leak into the unit file via unfiltered envsubst.
  envsubst '${INSTALL_DIR} ${CONFIG_DIR}' < "${TEMPLATE_DIR}/tokenpanel.service" > "$unit_file"

  systemctl daemon-reload
  systemctl enable tokenpanel

  ok "systemd service installed and enabled"
  info "  start on boot: automatic (enabled) via tokenpanel start"
  info "  manual: systemctl start|stop|restart tokenpanel"
  info "  logs:   journalctl -u tokenpanel -f"
}

uninstall_systemd_service() {
  systemctl disable tokenpanel 2>/dev/null || true
  rm -f /etc/systemd/system/tokenpanel.service
  systemctl daemon-reload
  ok "systemd service removed"
}