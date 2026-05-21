#!/usr/bin/env bash
# Folia Bridge — single-command USB start.
#
# Delegates device prep to reconnect.sh (clears wireless, finds USB
# serial, sets the tcp:9008 forward, verifies u2), then pins
# BRIDGE_DEVICE and execs the bridge poller. Same script the mac-app's
# "Start bridge" button runs.

set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ -f "$DIR/.env" ]; then
  set -a; . "$DIR/.env"; set +a
fi

./reconnect.sh

DEVICE_FILE="$DIR/.bridge-device"
if [ -f "$DEVICE_FILE" ]; then
  export BRIDGE_DEVICE="$(cat "$DEVICE_FILE")"
  echo "→ Bridge will use device $BRIDGE_DEVICE"
fi

exec node "$DIR/index.js"
