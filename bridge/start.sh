#!/usr/bin/env bash
# Folia Bridge — single-command wireless start.
#
# Chains reconnect.sh (find phone, adb connect, forward, u2 check) and
# then runs the bridge poller pinned to the wireless device. Pinning
# matters because the operator usually also has the phone plugged in
# via USB — without `-s <target>` every adb call would fail with
# "more than one device/emulator".

set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Make FOLIA_API_URL + BRIDGE_TOKEN available to reconnect.sh so it can
# pull the helper-reported target from Vercel before falling back to
# mDNS. Both live in bridge/.env (untracked) per the existing setup.
if [ -f "$DIR/.env" ]; then
  set -a; . "$DIR/.env"; set +a
fi

./reconnect.sh

TARGET_FILE="$DIR/.wireless-target"
if [ -f "$TARGET_FILE" ]; then
  # reconnect.sh writes the verified ip:port here on success.
  export BRIDGE_DEVICE="$(cat "$TARGET_FILE")"
  echo "→ Bridge will use device $BRIDGE_DEVICE"
fi

exec node "$DIR/index.js"
