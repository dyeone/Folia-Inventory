# Folia Bridge Helper (Android)

A small companion app that sits on the phone during a live sale and shows:

- **Connection rollup** — green/red "Ready for Mac to connect" indicator that combines WiFi + wireless ADB into one glance-level signal, plus a primary **Connect to ADB Server** button that jumps straight to the Wireless Debugging settings panel
- **WiFi** — network name (SSID, with optional permission grant) and IP, tap-to-copy, plus a QR encoding of `adb connect <ip>:<port>`
- **Wireless ADB** — separate indicators for Android 11+ Wireless Debugging (`service.adb.tls.port`, dynamic port) and legacy TCP mode (`service.adb.tcp.port`, usually 5555), with a fallback **Open Developer Options** button
- **u2 server status** — pings `http://127.0.0.1:9008/ping` every 3 s
- **Keep screen on** — toggle to prevent the phone from sleeping and dropping the ADB connection mid-sale

## Build

Requires Java 17 and the Android SDK (platform-tools + platforms;android-34 + build-tools;34.0.0).

```sh
cd android-helper
./gradlew assembleDebug
```

Output APK: `app/build/outputs/apk/debug/app-debug.apk`

## Install

With the phone connected over ADB:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Then open "Folia Bridge Helper" from the app drawer.

## What it doesn't do

The app cannot _enable_ wireless ADB itself — Android requires that toggle
to be flipped manually in Developer Options → Wireless debugging (or via
`adb tcpip 5555` from a USB-connected Mac). The **Connect to ADB Server**
button is the next best thing: it deep-links straight to the Wireless
Debugging settings panel so the operator only has to flip the toggle and
(first time only) tap "Pair device with pairing code".
