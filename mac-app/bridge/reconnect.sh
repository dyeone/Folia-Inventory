#!/usr/bin/env bash
# Folia Bridge — initialize a USB-connected phone for the bridge.
#
# Runs the same device prep that start.sh does, but standalone so the
# mac-app "Reconnect phone" button can recover from cable blips, a
# dropped tcp:9008 forward, or a crashed u2 server without bouncing the
# whole bridge subprocess.
#
# Steps:
#   1. Find the USB device serial
#   2. Re-establish the tcp:9008 forward so the u2 server is reachable
#   3. Verify u2; relaunch if dead
#
# Side effects: writes the serial to .bridge-device so start.sh can
# pin BRIDGE_DEVICE without re-running the discovery.

set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# A wedged adb link won't show the phone in `adb devices` until the host
# daemon is restarted — `adb reconnect` doesn't un-wedge it on this rig, but
# kill-server/start-server forces a USB re-enumeration that brings it back.
# Do that first so "Reconnect phone" recovers a dropped link, not just a
# stale forward.
echo "→ Restarting adb server"
adb kill-server  >/dev/null 2>&1 || true
adb start-server >/dev/null 2>&1 || true

USB_SERIAL=$(adb devices \
  | awk 'NR>1 && $2=="device" {print $1}' \
  | head -n 1)

if [ -z "$USB_SERIAL" ]; then
  cat >&2 <<EOF
✗ No USB ADB device detected.

  1. Plug the phone in with a data-capable USB cable.
  2. On phone: Settings > Developer options > USB debugging > On.
  3. Accept the "Allow USB debugging" prompt on the phone.
  4. Re-run.
EOF
  exit 1
fi

echo "→ Found USB device $USB_SERIAL"

echo "→ Setting up adb forward tcp:9008 → phone:9008"
adb -s "$USB_SERIAL" forward tcp:9008 tcp:9008 >/dev/null
echo "  ✓ forward live"

echo "→ Pinging u2 server"
if curl -sSf -m 2 http://localhost:9008/ping >/dev/null 2>&1; then
  echo "  ✓ u2 responding"
else
  echo "  u2 dead — relaunching"
  adb -s "$USB_SERIAL" shell pkill -f 'com.wetest.uia2' >/dev/null 2>&1 || true
  sleep 1
  adb -s "$USB_SERIAL" shell "nohup sh -c 'CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main' > /sdcard/u2.log 2>&1 &" >/dev/null
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    if curl -sSf -m 2 http://localhost:9008/ping >/dev/null 2>&1; then
      echo "  ✓ u2 responding after ${i}s"
      break
    fi
    [ "$i" = "8" ] && echo "  ⚠ u2 still not responding — bridge will fall back to slow ADB dumps"
  done
fi

echo "$USB_SERIAL" > "$DIR/.bridge-device"
echo "Done. Device $USB_SERIAL ready."
