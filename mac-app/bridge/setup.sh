#!/usr/bin/env bash
# Folia Bridge — one-shot setup + run.
#
# Idempotent. Safe to re-run.
#
# Usage:
#   ./setup.sh <BRIDGE_TOKEN>
#   BRIDGE_TOKEN=... ./setup.sh
#
# What it does, in order:
#   1. Installs node, android-platform-tools, python via Homebrew if missing
#   2. Confirms an ADB device is plugged in (waits for user if not)
#   3. Writes bridge/.env with FOLIA_API_URL + BRIDGE_TOKEN
#   4. Installs the uiautomator2 Python lib (one-time)
#   5. Pushes the u2 server jar to the phone (one-time per phone)
#   6. Launches the u2 server on the phone if not already running
#   7. Sets up adb forward tcp:9008 → phone:9008
#   8. Pings the u2 server to confirm reachability
#   9. Starts `npm start`

set -euo pipefail

API_URL="${FOLIA_API_URL:-https://folia-inventory.vercel.app}"
BRIDGE_TOKEN="${1:-${BRIDGE_TOKEN:-}}"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

step() { printf '\n→ %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

if [ -z "$BRIDGE_TOKEN" ]; then
  cat <<'EOF' >&2

Missing BRIDGE_TOKEN.

Generate one in the browser console while signed in to Folia:

  fetch('/api/bridge?action=generate-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'generate-token',
      userId: JSON.parse(localStorage.getItem('session-current-user')).id,
    }),
  }).then(r => r.json()).then(console.log)

Then re-run:  ./setup.sh <token>

(Generating a new token instantly kicks any other running bridge offline.)
EOF
  exit 1
fi

# ─── 1. Prerequisites ──────────────────────────────────────────────────────
step "Checking Homebrew + CLI tools"
command -v brew >/dev/null 2>&1 || fail "Homebrew not found. Install from https://brew.sh first."

ensure_brew() {
  local pkg="$1"
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    echo "  ✓ $pkg"
  else
    echo "  installing $pkg ..."
    brew install "$pkg"
  fi
}
ensure_brew node
ensure_brew android-platform-tools
command -v python3 >/dev/null 2>&1 || ensure_brew python

# ─── 2. ADB device ─────────────────────────────────────────────────────────
step "Looking for a connected Android device"
adb start-server >/dev/null 2>&1 || true
if ! adb devices | awk 'NR>1 && $2=="device"' | grep -q .; then
  fail "No ADB device authorized. Plug the phone in via USB, accept the auth prompt on its screen, then re-run."
fi
DEVICE=$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')
echo "  ✓ $DEVICE"

# ─── 3. bridge/.env ────────────────────────────────────────────────────────
step "Writing bridge/.env"
cat > .env <<EOF
FOLIA_API_URL=$API_URL
BRIDGE_TOKEN=$BRIDGE_TOKEN
EOF
echo "  ✓ $(pwd)/.env"

# ─── 4. uiautomator2 Python lib ────────────────────────────────────────────
step "Installing uiautomator2 (Python, one-time)"
if python3 -c 'import uiautomator2' >/dev/null 2>&1; then
  echo "  ✓ already installed"
else
  pip3 install --user --break-system-packages uiautomator2 >/tmp/u2-install.log 2>&1 \
    || fail "pip install failed — see /tmp/u2-install.log"
  echo "  ✓ installed"
fi

# ─── 5. Push u2 server jar to the phone (idempotent) ───────────────────────
step "Initializing u2 server on the phone (idempotent)"
python3 -m uiautomator2 init >/tmp/u2-init.log 2>&1 || true
echo "  ✓ done (log: /tmp/u2-init.log)"

# ─── 6. ADB port forward (set up first so we can probe HTTP) ───────────────
step "Setting up adb forward tcp:9008 → phone:9008"
adb forward tcp:9008 tcp:9008 >/dev/null
echo "  ✓ done"

# ─── 7. Ensure u2 server is actually responding ────────────────────────────
# Pgrep alone is unreliable: `python3 -m uiautomator2 init` leaves a
# transient process matching com.wetest.uia2.Main that dies seconds
# later. The only honest test is "does HTTP /ping reply?" via the
# forward we just set up. If not, kill any zombies and relaunch detached.
step "Ensuring u2 server is responding"
ping_ok() { curl -sSf -m 2 http://localhost:9008/ping >/dev/null 2>&1; }

if ping_ok; then
  echo "  ✓ already responding"
else
  adb shell pkill -f 'com.wetest.uia2.Main' >/dev/null 2>&1 || true
  sleep 1
  adb shell "nohup sh -c 'CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main' > /dev/null 2>&1 &"
  # Server takes ~2-3 s to bind. Retry the ping for up to 8 s before giving up.
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    if ping_ok; then
      echo "  ✓ launched and responding"
      break
    fi
    if [ "$i" = "8" ]; then
      echo "  ⚠ launched but not responding — bridge will fall back to slow ADB dumps (~3× slower)"
    fi
  done
fi

# ─── 9. Start the bridge ───────────────────────────────────────────────────
step "Starting bridge (Ctrl-C to stop)"
echo
exec npm start
