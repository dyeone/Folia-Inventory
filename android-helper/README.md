# Folia Bridge Helper (Android)

A small companion app that sits on the phone during a live sale and shows:

- **WiFi IP** — big, readable, with a tap-to-copy and a QR encoding of `adb connect <ip>:5555`
- **ADB status** — whether the device is currently in TCP/IP mode (`getprop service.adb.tcp.port`)
- **u2 server status** — pings `http://127.0.0.1:9008/ping` every 3 s
- **Keep screen on** — toggle to prevent the phone from sleeping and dropping the ADB connection mid-sale
- **Open Developer Options** — shortcut button

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
`adb tcpip 5555` from a USB-connected Mac). The "Open Developer Options"
button takes you straight to that screen.
