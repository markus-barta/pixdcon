#!/usr/bin/env bash
#
# awtrix-rescue — push home-WiFi credentials to an AWTRIX device stuck in
# AP-mode captive-portal. One command, zero typing, no LLM in the loop.
#
# USAGE
#   ./scripts/awtrix-rescue.sh                       # push, no LAN verify
#   ./scripts/awtrix-rescue.sh <target-ip>           # push + verify device joins LAN at <target-ip>
#
# PREREQUISITES
#   1. You have joined the device's AP (SSID `AWTRIX_<uid-suffix>`) in your
#      WiFi menu. AP captive portal is at http://192.168.4.1.
#      (On a dual-NIC host like Ethernet + WiFi-on-AP, your main internet
#      stays up — no Claude/SSH/shell-session interruption.)
#
#   2. /Users/mba/.inspr/secrets/agents/HOMEWIFI.env is materialized
#      (via inspr.secrets.agents HM module). Contents:
#          HOMEWIFI_SSID=<your home network ssid>
#          HOMEWIFI_PASS=<your home network password>
#
# ENV-VAR OVERRIDES
#   HOMEWIFI_ENV   path to env file              (default: ~/.inspr/secrets/agents/HOMEWIFI.env)
#   AP_HOST        AWTRIX AP captive-portal host (default: 192.168.4.1)
#   VERIFY_TIMEOUT seconds to wait for LAN join  (default: 30)
#
# SECURITY
#   Password never enters argv (curl reads via `-F 'password=<file'`),
#   never printed to stdout/stderr, tempfile is mode 0600 and shredded on exit.
#
set -euo pipefail

HOMEWIFI_ENV="${HOMEWIFI_ENV:-$HOME/.inspr/secrets/agents/HOMEWIFI.env}"
AP_HOST="${AP_HOST:-192.168.4.1}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-30}"
TARGET_IP="${1:-}"

log()  { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { log "ERR: $*" >&2; exit 1; }

# ── Pre-flight ────────────────────────────────────────────────────────────
[ -r "$HOMEWIFI_ENV" ] || fail "$HOMEWIFI_ENV not readable. \`just switch\` on nixcfg to materialize."

ping -c 1 -W 1500 "$AP_HOST" >/dev/null 2>&1 \
  || fail "$AP_HOST unreachable. Join the device's AP (SSID 'AWTRIX_<id>') in WiFi menu first."

ver=$(curl -sf --max-time 3 "http://$AP_HOST/version" || true)
case "$ver" in
  0.*|1.*) log "found AWTRIX firmware $ver at $AP_HOST" ;;
  *)       fail "$AP_HOST responded with unexpected /version: '${ver}' — not an AWTRIX captive portal?" ;;
esac

# ── Source creds (subshell-style, never read into argv or logs) ───────────
set -a
# shellcheck source=/dev/null
source "$HOMEWIFI_ENV"
set +a
: "${HOMEWIFI_SSID:?HOMEWIFI_SSID empty in $HOMEWIFI_ENV}"
: "${HOMEWIFI_PASS:?HOMEWIFI_PASS empty in $HOMEWIFI_ENV}"

# ── Stage password via tempfile (avoids argv exposure) ────────────────────
tmp="$(mktemp -t awtrix-rescue.XXXX)"
chmod 600 "$tmp"
trap 'rm -f "$tmp" /tmp/awtrix-rescue-resp.$$' EXIT
printf '%s' "$HOMEWIFI_PASS" > "$tmp"

# ── Push creds ────────────────────────────────────────────────────────────
log "POST $AP_HOST/connect  (ssid=$HOMEWIFI_SSID, password=*** redacted ***)"
code=$(curl -s -o "/tmp/awtrix-rescue-resp.$$" -w "%{http_code}" --max-time 15 \
  -X POST \
  -F "ssid=$HOMEWIFI_SSID" \
  -F "password=<$tmp" \
  -F "persistent=true" \
  "http://$AP_HOST/connect")

case "$code" in
  200) log "POST /connect → HTTP 200 (response: $(head -c 160 "/tmp/awtrix-rescue-resp.$$"))" ;;
  *)   fail "POST /connect → HTTP $code. Body: $(cat "/tmp/awtrix-rescue-resp.$$")" ;;
esac

# ── Optional LAN-side verification ────────────────────────────────────────
if [ -z "$TARGET_IP" ]; then
  log "done. Skipping LAN verify — no <target-ip> given."
  exit 0
fi

log "waiting up to ${VERIFY_TIMEOUT}s for $TARGET_IP to come online…"
for i in $(seq 1 "$VERIFY_TIMEOUT"); do
  if ping -c 1 -W 1000 "$TARGET_IP" >/dev/null 2>&1; then
    log "✓ $TARGET_IP responds after ${i}s. Device on LAN."
    exit 0
  fi
  sleep 1
done
fail "$TARGET_IP still unreachable after ${VERIFY_TIMEOUT}s. Check device + home WiFi association."
