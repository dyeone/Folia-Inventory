#!/usr/bin/env bash
# Folia Bridge — discover and connect to the phone over wireless ADB.
#
# Usage:
#   ./reconnect.sh                    # auto-discover via mDNS (preferred)
#   ./reconnect.sh 10.14.41.4         # explicit IP (legacy adb-tcpip mode)
#   ./reconnect.sh 10.14.41.4:5555    # explicit ip:port
#
# Two paths supported:
#
# (Preferred) Android 11+ Wireless Debugging — persists across reboots.
#   One-time setup:
#     1. On phone: Settings > Developer options > Wireless debugging > On
#     2. On phone: Tap "Pair device with pairing code". A pairing IP:port
#        and 6-digit code appear.
#     3. On Mac:   adb pair <pairing-ip:port> <code>
#   After that, this script discovers the phone via mDNS each session
#   (`adb mdns services` — same protocol Android Studio uses) and
#   reconnects automatically — no IP lookups, no re-pairing.
#
# (Legacy) adb tcpip 5555 — does NOT persist across phone reboot.
#   Plug in via USB, run `adb tcpip 5555`, unplug. Then this script can
#   reconnect with the saved IP (until the next reboot, when you redo
#   the USB step).
#
# What this script does each run:
#   1. Discover the phone via mDNS, or fall back to a saved/passed IP
#   2. `adb connect` to it
#   3. Re-establish the tcp:9008 forward so u2 server is reachable
#   4. Verify u2; relaunch if dead

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TARGET_FILE="$SCRIPT_DIR/.wireless-target"

# ─── Resolve target ────────────────────────────────────────────────────────
TARGET=""

if [ -n "${1:-}" ]; then
  TARGET="$1"
elif [ -n "${WIRELESS_TARGET:-}" ]; then
  TARGET="$WIRELESS_TARGET"
else
  echo "→ Discovering phone via mDNS (Android 11+ Wireless Debugging)…"
  # `adb mdns services` lists devices advertising adb services on the LAN.
  # `_adb-tls-connect._tcp` is the post-pair connect service; that's the
  # endpoint we want. Allow a few retries because mDNS can take a moment
  # after the phone joins WiFi.
  for i in 1 2 3 4 5 6 7 8; do
    line=$(adb mdns services 2>/dev/null | awk '/_adb-tls-connect/ {print $3; exit}' || true)
    if [ -n "$line" ]; then
      TARGET="$line"
      echo "  ✓ found $TARGET"
      break
    fi
    sleep 1
  done

  # Fall back to a previously-saved IP if mDNS turned up nothing.
  if [ -z "$TARGET" ] && [ -f "$TARGET_FILE" ]; then
    TARGET=$(cat "$TARGET_FILE")
    echo "  mDNS came up empty; falling back to saved $TARGET"
  fi
fi

if [ -z "$TARGET" ]; then
  cat >&2 <<EOF
✗ No phone found and no saved/passed IP.

Most likely Wireless Debugging isn't enabled or the Mac isn't paired
with this phone yet:

  1. On phone: Settings > Developer options > Wireless debugging > On
  2. On phone: Tap "Pair device with pairing code"
  3. On this Mac, with the pairing IP:port and code shown on the phone:
       adb pair <pair-ip:port> <code>
  4. Re-run this script — it'll find the phone via mDNS.

Or, for legacy USB-bootstrapped mode:
  ./reconnect.sh <phone-wifi-ip>
EOF
  exit 1
fi

# Default the port to 5555 if not specified (legacy tcpip path).
case "$TARGET" in
  *:*) ;;
  *)   TARGET="$TARGET:5555" ;;
esac

# ─── Connect ───────────────────────────────────────────────────────────────
echo "→ Connecting to $TARGET"
adb connect "$TARGET" >/tmp/folia-adb-connect.log 2>&1 || true
if ! adb devices | awk -v t="$TARGET" 'NR>1 && $1==t && $2=="device"' | grep -q .; then
  cat >&2 <<EOF
✗ adb couldn't reach $TARGET.

Common causes:
  - Phone isn't on the same WiFi as this Mac
  - Wireless Debugging was disabled, or the pairing was forgotten
    (re-pair via Settings > Developer options > Wireless debugging)
  - Phone's adb fell out of TCP/IP mode (legacy tcpip mode resets on
    reboot — plug in via USB, run \`adb tcpip 5555\`, unplug, retry)

adb output:
EOF
  cat /tmp/folia-adb-connect.log >&2
  exit 1
fi

echo "$TARGET" > "$TARGET_FILE"
echo "  ✓ connected, saved to $TARGET_FILE"

# ─── Forward + u2 ──────────────────────────────────────────────────────────
echo "→ Setting up adb forward tcp:9008 → phone:9008"
adb forward tcp:9008 tcp:9008 >/dev/null
echo "  ✓ forward live"

echo "→ Pinging u2 server"
if curl -sSf -m 2 http://localhost:9008/ping >/dev/null 2>&1; then
  echo "  ✓ u2 responding"
else
  echo "  u2 dead — relaunching"
  adb shell pkill -f 'com.wetest.uia2' >/dev/null 2>&1 || true
  sleep 1
  adb shell "nohup sh -c 'CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main' > /sdcard/u2.log 2>&1 &" >/dev/null
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    if curl -sSf -m 2 http://localhost:9008/ping >/dev/null 2>&1; then
      echo "  ✓ u2 responding after ${i}s"
      break
    fi
    [ "$i" = "8" ] && echo "  ⚠ u2 still not responding — bridge will fall back to slow ADB dumps"
  done
fi

echo
echo "Done. Bridge will pick up the wireless device automatically on the next poll."
