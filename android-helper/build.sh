#!/usr/bin/env bash
# Build the Folia Bridge Helper APK and (optionally) install it.
#
# Usage:
#   ./build.sh              # build only
#   ./build.sh --install    # build + adb install on the connected device
#
# Prereqs (one-time):
#   brew install --cask temurin@17 android-commandlinetools
#   brew install gradle
#   export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
#   yes | sdkmanager --licenses
#   sdkmanager 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0'

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

if ! command -v gradle >/dev/null 2>&1; then
  echo "✗ gradle not on PATH. Install with:  brew install gradle" >&2
  exit 1
fi
if [ -z "${JAVA_HOME:-}" ]; then
  if /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
    export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
  else
    echo "✗ Java 17 not found. Install with:  brew install --cask temurin@17" >&2
    exit 1
  fi
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  # Best-effort guess of where brew put the cmdline tools.
  if [ -d /opt/homebrew/share/android-commandlinetools ]; then
    export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
  else
    echo "✗ ANDROID_HOME not set and default brew path missing." >&2
    exit 1
  fi
fi

echo "→ Building with"
echo "  gradle       $(gradle --version | awk '/^Gradle /{print $2}' | head -1)"
echo "  JAVA_HOME    $JAVA_HOME"
echo "  ANDROID_HOME $ANDROID_HOME"

gradle assembleDebug

APK="$SCRIPT_DIR/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK" ]; then
  echo "✗ build claimed success but APK not found at $APK" >&2
  exit 1
fi
echo "✓ APK: $APK"

if [ "${1:-}" = "--install" ]; then
  echo "→ Installing to connected device"
  adb install -r "$APK"
fi
