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

## Updates

The app checks for a newer build on launch, every 6h while open, and on
demand via **Check for updates** in the header. When one is published it
shows a banner with a **Download** button that opens the new DMG in the
browser — drag it over the old app in `/Applications` to install.

There's no silent in-place auto-update: the app ships unsigned
(`build.mac.identity = null`), and macOS won't let an unsigned bundle
replace itself (Squirrel.Mac requires a valid code signature). The check
hits `GET {FOLIA_API_URL}/api/bridge?action=mac-version`, which reads the
`app_settings` row `id='mac_release'`.

### Publishing a new build

1. `npm run dist` → `dist/Folia Bridge-X.Y.Z-universal.dmg`.
2. Upload that DMG somewhere with a stable public URL (e.g. a public
   Supabase Storage bucket).
3. Point the release row at it (bump `version` to match `package.json`):

   ```sql
   insert into app_settings (id, data)
   values ('mac_release', '{
     "version": "0.2.2",
     "url": "https://<public-host>/Folia%20Bridge-0.2.2-universal.dmg",
     "notes": "What changed in this build"
   }'::jsonb)
   on conflict (id) do update set data = excluded.data;
   ```

   Every open app picks it up within 6h (or immediately on a manual
   check). Until the row exists the check returns nulls and no banner
   appears — so no false prompts.

## Limitations / next steps

- The bridge subprocess inherits the app's PATH. `adb` needs to be
  reachable — typically `/opt/homebrew/bin/adb` via Homebrew. If you
  see `adb: command not found` in the log, install `android-platform-tools`
  (`brew install --cask android-platform-tools`) and restart the app.
- Updates are download-and-drag, not silent. True background auto-update
  would need an Apple Developer ID + code signing + notarization, then
  swapping the manual check for `electron-updater`.
