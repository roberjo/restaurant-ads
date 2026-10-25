#!/usr/bin/env bash
# Turn a Raspberry Pi (Raspberry Pi OS Bookworm, desktop) into a managed screen player.
#
#   sudo ./install.sh --server https://ads.example.com [--user pi]
#
# Installs Chromium (kiosk), cec-utils (HDMI-CEC TV control), the screen agent service and a
# desktop autostart entry. Safe to re-run.
set -euo pipefail

SERVER_URL=""
KIOSK_USER="${SUDO_USER:-pi}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER_URL="${2:-}"; shift 2 ;;
    --user) KIOSK_USER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -n "$SERVER_URL" ] || { echo "--server is required" >&2; exit 2; }
case "$SERVER_URL" in https://*|http://localhost*|http://127.0.0.1*) ;; *) echo "use an https:// server URL" >&2; exit 2 ;; esac
id "$KIOSK_USER" >/dev/null 2>&1 || { echo "user $KIOSK_USER does not exist" >&2; exit 1; }
KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq curl jq cec-utils unclutter >/dev/null
apt-get install -y -qq chromium >/dev/null 2>&1 || apt-get install -y -qq chromium-browser >/dev/null

echo "==> Writing configuration"
install -d -m 0755 /etc
printf 'SERVER_URL=%s\n' "${SERVER_URL%/}" > /etc/screen-agent.conf
chmod 0644 /etc/screen-agent.conf
install -d -m 0700 -o "$KIOSK_USER" -g "$KIOSK_USER" /var/lib/screen-agent

echo "==> Installing scripts"
install -m 0755 "$HERE/screen-agent.sh" /usr/local/bin/screen-agent
install -m 0755 "$HERE/kiosk.sh" /usr/local/bin/screen-kiosk

# HDMI-CEC needs the video group.
usermod -aG video "$KIOSK_USER"

cat > /etc/systemd/system/screen-agent.service <<UNIT
[Unit]
Description=Screen agent (device registration and HDMI-CEC power schedule)
After=network-online.target
Wants=network-online.target

[Service]
User=$KIOSK_USER
ExecStart=/usr/local/bin/screen-agent
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/screen-agent
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Configuring kiosk autostart"
install -d -o "$KIOSK_USER" -g "$KIOSK_USER" "$KIOSK_HOME/.config/autostart"
cat > "$KIOSK_HOME/.config/autostart/screen-kiosk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Screen kiosk
Exec=/usr/local/bin/screen-kiosk
X-GNOME-Autostart-enabled=true
DESKTOP
chown "$KIOSK_USER:$KIOSK_USER" "$KIOSK_HOME/.config/autostart/screen-kiosk.desktop"

# Never blank the screen; boot to the desktop with auto-login.
if command -v raspi-config >/dev/null 2>&1; then
  raspi-config nonint do_blanking 1 || true
  raspi-config nonint do_boot_behaviour B4 || true
fi

systemctl daemon-reload
systemctl enable --now screen-agent.service

echo
echo "Done. Reboot to start the kiosk: sudo reboot"
echo "The TV will show a pairing code. Enter it in the operator console under Screens → Pair."
