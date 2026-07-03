#!/usr/bin/env bash
# Systemd service management — sourced by bin/tokenpanel-setup and bin/tokenpanel.

install_systemd_service() {
  source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/output.sh"
  source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/config.sh"

  step "systemd" "installing service..."

  local unit_file="/etc/systemd/system/tokenpanel.service"
  export INSTALL_DIR CONFIG_DIR

  envsubst < "${TEMPLATE_DIR}/tokenpanel.service" > "$unit_file"

  systemctl daemon-reload
  systemctl enable tokenpanel

  ok "systemd service installed and enabled"
  info "  start on boot: automatic (enabled)"
  info "  manual: systemctl start|stop|restart tokenpanel"
  info "  logs:   journalctl -u tokenpanel -f"
}

uninstall_systemd_service() {
  systemctl disable tokenpanel 2>/dev/null || true
  rm -f /etc/systemd/system/tokenpanel.service
  systemctl daemon-reload
  ok "systemd service removed"
}