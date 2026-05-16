#!/usr/bin/env bash
# Folia Bridge — reconnect to a wireless ADB device.
#
# Usage:
#   ./reconnect.sh                    # use last saved IP
#   ./reconnect.sh 10.14.41.4         # connect to that IP, save for next time
#   ./reconnect.sh 10.14.41.4:5555    # explicit port (defaults to 5555)
#
# What it does:
#   1. Connects to <IP>:<PORT> via adb
#   2. Saves the address to bridge/.wireless-target so the no-arg form
#      works next time
#   3. Re-establishes the tcp:9008 forward so u2 server is reachable
#   4. Pings u2; if dead, relaunches it on the phone
#
# When you might need to re-run this:
#   - Phone's WiFi dropped / reconnected (IP may have changed)
#   - You restarted the Mac
#   - You restarted the bridge
#
# Note: `adb tcpip 5555` resets to USB mode when the phone reboots. If
# this script fails to connect after a phone reboot, plug the phone in
# briefly, run `adb tcpip 5555`, unplug, then re-run this script.
# (Or set up persistent Wireless Debugging via the phone's developer
# options — Android 11+ remembers paired devices across reboots.)

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TARGET_FILE="$SCRIPT_DIR/.wireless-target"

# Resolve the target address from args, env, or saved file.
arg="${1:-}"
if [ -n "$arg" ]; then
  TARGET="$arg"
elif [ -n "${WIRELESS_TARGET:-}" ]; then
  TARGET="$WIRELESS_TARGET"
elif [ -f "$TARGET_FILE" ]; then
  TARGET=$(cat "$TARGET_FILE")
else
  cat >&2 <<EOF
No target IP supplied and no saved one found.

Find the phone's IP in Settings → About phone → IP address (it's the
wlan/WiFi one). Then run:

  ./reconnect.sh <IP>

Example:  ./reconnect.sh 10.14.41.4
EOF
  exit 1
fi

# Default the port to 5555 if not specified.
case "$TARGET" in
  *:*) ;;
  *)   TARGET="$TARGET:5555" ;;
esac

echo "→ Connecting to $TARGET"
adb connect "$TARGET" >/tmp/folia-adb-connect.log 2>&1
if ! adb devices | awk -v t="$TARGET" 'NR>1 && $1==t && $2=="device"' | grep -q .; then
  cat >&2 <<EOF
✗ adb couldn't reach $TARGET.

Common causes:
  - Phone isn't on the same WiFi as this Mac
  - Phone's adb fell out of TCP/IP mode (happens on reboot). Plug
    USB in briefly, run \`adb tcpip 5555\`, unplug, retry.
  - Phone's IP changed. Find the new IP and pass it as an arg.

adb output:
EOF
  cat /tmp/folia-adb-connect.log >&2
  exit 1
fi

echo "$TARGET" > "$TARGET_FILE"
echo "  ✓ connected, saved to $TARGET_FILE"

# Re-establish the u2 forward. Idempotent — `adb forward` replaces any
# existing forward on the same local port.
echo "→ Setting up adb forward tcp:9008 → phone:9008"
adb forward tcp:9008 tcp:9008 >/dev/null
echo "  ✓ forward live"

# Verify u2. If it's not responding, relaunch it on the device.
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
