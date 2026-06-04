# Folia Bridge — macOS helper app

Wraps the Node bridge (bundled at `bridge/`) in a window UI so the
operator can start/stop the bridge, reconnect the phone, edit the
Vercel config, and tail logs without leaving the terminal open.

## Architecture

```
+----------------------+      spawn      +-------------------+
| Electron main.js     | --------------> | bridge/start.sh    |
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

The bridge lives inside this app at `bridge/` — one source of truth.
In dev the app runs it from there directly; electron-builder copies the
same folder into `Contents/Resources/bridge/` when packaging a `.app`,
so the bridge and the app always ship together and can't drift.

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

- **Start / Stop / Restart**: spawn `bash bridge/start.sh` and
  watch its stdout/stderr. Killing the window quits the bridge too.
- **Reconnect phone**: runs `bridge/reconnect.sh` standalone (uses
  the helper-reported target from Vercel, falls back to mDNS).
- **Config**: reads + writes `bridge/.env` so `BRIDGE_URL` and
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

One command does all of it — `publish-release.sh` builds the DMG, attaches
it to a GitHub release, and moves the update pointer:

```bash
cd mac-app
# bump "version" in package.json (and commit it) first, then:
./publish-release.sh "What changed in this build"
```

It (1) runs `npm run dist`, (2) creates/updates GitHub release
`folia-bridge-v<version>` on the (public) repo with the DMG as a
space-free public asset, and (3) upserts the `app_settings` row
`id='mac_release'` to `{version, url, notes}` — then verifies the live
`mac-version` API serves the new version and the asset downloads.

Prereqs: `gh` (authenticated), `node`, `python3`, and a repo-root
`.env.local` with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.

Why GitHub Releases and not Supabase Storage: this project's Supabase
Storage caps uploads at 50 MB and the DMG is ~170 MB. To move hosting,
change only the `url` written to the row — the version check stays on the
Folia API.

Open apps pick up a new version within 6h or on a manual check. Until the
row exists the check returns nulls and no banner appears, so no false
prompts.

To set the pointer by hand instead of the script:

```sql
insert into app_settings (id, data) values ('mac_release', '{
  "version": "0.2.3",
  "url": "https://github.com/<owner>/<repo>/releases/download/folia-bridge-v0.2.3/folia-bridge-0.2.3-universal.dmg",
  "notes": "What changed in this build"
}'::jsonb)
on conflict (id) do update set data = excluded.data;
```

## Limitations / next steps

- The bridge subprocess inherits the app's PATH. `adb` needs to be
  reachable — typically `/opt/homebrew/bin/adb` via Homebrew. If you
  see `adb: command not found` in the log, install `android-platform-tools`
  (`brew install --cask android-platform-tools`) and restart the app.
- Updates are download-and-drag, not silent. True background auto-update
  would need an Apple Developer ID + code signing + notarization, then
  swapping the manual check for `electron-updater`.
