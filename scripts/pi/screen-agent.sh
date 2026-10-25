#!/usr/bin/env bash
# Screen agent: registers this device on first run, then keeps the TV's power and input in sync
# with the venue's open hours over HDMI-CEC (on 15 min before opening, standby 15 min after close).
set -euo pipefail

CONF="${CONF:-/etc/screen-agent.conf}"
STATE_DIR="${STATE_DIR:-/var/lib/screen-agent}"
POLL_SECONDS="${POLL_SECONDS:-60}"
CRED_FILE="$STATE_DIR/device"

# shellcheck source=/dev/null
. "$CONF"
: "${SERVER_URL:?SERVER_URL must be set in $CONF}"

log() { echo "screen-agent: $*"; }

register() {
  local body tmp
  body="$(curl -fsS --max-time 20 -X POST "$SERVER_URL/api/device/register")"
  tmp="$(mktemp "$STATE_DIR/device.XXXXXX")"
  jq -r '"DEVICE_ID=\(.deviceId)\nDEVICE_SECRET=\(.deviceSecret)"' <<<"$body" > "$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$CRED_FILE"
  log "registered device $(jq -r .deviceId <<<"$body")"
}

cec() {
  command -v cec-client >/dev/null 2>&1 || return 0
  echo "$1" | cec-client -s -d 1 >/dev/null 2>&1 || log "cec command '$1' failed"
}

until [ -s "$CRED_FILE" ]; do
  register || { log "registration failed, retrying"; sleep 30; }
done

# shellcheck source=/dev/null
. "$CRED_FILE"
last=""
while true; do
  if power="$(curl -fsS --max-time 15 -H "Authorization: Device $DEVICE_ID.$DEVICE_SECRET" "$SERVER_URL/api/device/power" | jq -r .power)"; then
    if [ "$power" != "$last" ]; then
      case "$power" in
        on) log "TV on"; cec "on 0"; sleep 8; cec "as" ;;   # power on, then make us the active input
        standby) log "TV standby"; cec "standby 0" ;;
        *) log "unexpected power state: $power" ;;
      esac
      last="$power"
    fi
  else
    log "server unreachable; keeping current TV state"
  fi
  sleep "$POLL_SECONDS"
done
