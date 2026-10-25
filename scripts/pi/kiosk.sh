#!/usr/bin/env bash
# Launch the player full screen and relaunch it if the browser ever exits.
set -euo pipefail

CONF="${CONF:-/etc/screen-agent.conf}"
CRED_FILE="${STATE_DIR:-/var/lib/screen-agent}/device"
# shellcheck source=/dev/null
. "$CONF"

BROWSER="$(command -v chromium || command -v chromium-browser)"
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0.5 -root &

# Wait for the agent to register the device.
until [ -s "$CRED_FILE" ]; do sleep 2; done
# shellcheck source=/dev/null
. "$CRED_FILE"

while true; do
  "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
    --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 \
    --password-store=basic \
    "$SERVER_URL/player/#device=$DEVICE_ID.$DEVICE_SECRET" || true
  sleep 3
done
