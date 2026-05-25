# Folia Bridge — macOS helper app

Wraps the existing Node bridge (`../bridge/`) in a window UI so the
operator can start/stop the bridge, reconnect the phone, edit the
Vercel config, and tail logs without leaving the terminal open.

## Architecture

```
+----------------------+      spawn      +-------------------+
| Electron main.js     | --------------> | ../bridge/start.sh |
| (BrowserWindow + IPC)|                 | (node index.js)    |
+----------+-----------+ <-- stdout/err-+--------------------+
           |
           v
+----------------------+
| renderer/index.html  |
| renderer/app.js      |
| (status + log + cfg) |
+----------------------+
```

The bridge source code stays in `../bridge/` — the mac app references
it at runtime in dev, and electron-builder copies it into
`Contents/Resources/bridge/` when packaging a `.app`.

## Dev

```bash
cd mac-app
npm install          # ~120 MB Electron download, one-time
npm start            # opens the window
```

Edit the JS / CSS / HTML in `renderer/`, hit Cmd+R inside the window
to reload, no Electron restart needed.

## Building a distributable `.app`

```bash
npm run dist         # outputs dist/Folia Bridge-X.Y.Z.dmg
```

Code signing + notarization aren't set up — for in-house use that's
fine, but for distribution outside the org you'll need an Apple
Developer ID and the `electron-builder` mac signing config.

## What the app actually does

- **Start / Stop / Restart**: spawn `bash ../bridge/start.sh` and
  watch its stdout/stderr. Killing the window quits the bridge too.
- **Reconnect phone**: runs `../bridge/reconnect.sh` standalone (uses
  the helper-reported target from Vercel, falls back to mDNS).
- **Config**: reads + writes `../bridge/.env` so `BRIDGE_URL` and
  `BRIDGE_TOKEN` can be set without `vi`.
- **Logs**: every line streams to the window AND is tee'd to
  `~/Library/Logs/folia-bridge/bridge.log` for diagnosis after the
  fact.

## Limitations / next steps

- The bridge subprocess inherits the app's PATH. `adb` needs to be
  reachable — typically `/opt/homebrew/bin/adb` via Homebrew. If you
  see `adb: command not found` in the log, install `android-platform-tools`
  (`brew install --cask android-platform-tools`) and restart the app.
- No auto-update — operator pulls a new DMG manually when shipping
  a new build.
