# Raspberry Pi player

Turns a Raspberry Pi into a managed screen: full-screen kiosk player, automatic restart, and **HDMI-CEC TV control**. The TV turns on 15 minutes before the venue opens, switches to the Pi's input, and goes to standby 15 minutes after closing, following the venue's open hours in the console.

Why a Pi: Android/Fire TV apps generally can't send HDMI-CEC commands (it's a system-level API), while `cec-client` on a Pi can.

## Hardware
- Raspberry Pi 4 or 5 (2 GB+), official power supply, micro-HDMI → HDMI cable, 16 GB+ microSD
- The TV must have HDMI-CEC enabled (Samsung "Anynet+", LG "SimpLink", Sony "Bravia Sync", Vizio "CEC")

## Install
1. Flash **Raspberry Pi OS (Bookworm, with desktop)**, set Wi-Fi and a user in Raspberry Pi Imager.
2. Copy this folder to the Pi and run:
   ```sh
   sudo ./install.sh --server https://your-platform.example.com
   sudo reboot
   ```
3. The TV shows a 6-character code. Enter it in the console under **Screens → Pair**.

## What gets installed
| Piece | What it does |
|---|---|
| `screen-agent` (systemd service) | Registers the device on first boot (credentials in `/var/lib/screen-agent/device`, mode 600), then polls `GET /api/device/power` every minute and sends CEC `on`/`as`/`standby`. Polling doesn't count as a heartbeat, so a crashed browser still shows as offline. |
| `screen-kiosk` (desktop autostart) | Launches Chromium in kiosk mode with the device credentials and relaunches it if it exits. |
| Packages | `chromium`, `cec-utils`, `jq`, `curl`, `unclutter` |

## Troubleshooting
- `journalctl -u screen-agent -f`: agent logs (registration, TV on/standby)
- `echo 'scan' | cec-client -s -d 1`: check that the TV is visible over CEC
- From the console: **Screens → Identify** shows the screen's name on the TV; **Reload** restarts the player
- Reset a device: `sudo rm /var/lib/screen-agent/device && sudo systemctl restart screen-agent`, then reboot and re-pair

Note: the device secret is passed to Chromium in the URL fragment (never sent to the server in requests or logs) and stored by the player in local storage. On this single-purpose device it's also visible in the local process list.
