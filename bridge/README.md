# Folia Bridge

Standalone local app that runs on the operator's Mac and drives the
Palmstreet Android phone via ADB. Decoupled from the inventory system on
Vercel — the bridge polls Vercel **outbound** for jobs, so there's no
inbound port, no tunnel, no cert juggling, no LAN setup.

```
┌─────────────────┐        ┌──────────────┐        ┌────────────┐
│  Folia (Vercel) │ ◀── HTTPS poll ── │  Bridge (Mac) │ ─adb→ │ Android    │
└─────────────────┘                   └──────────────┘        └────────────┘
```

## Quick start (one command)

```bash
git clone https://github.com/dyeone/Folia-Inventory.git
cd Folia-Inventory/bridge && ./setup.sh <BRIDGE_TOKEN>
```

`setup.sh` handles everything — installs Homebrew deps, sets up
`.env`, pushes the uiautomator2 server to the phone, configures the
ADB port forward, and starts the bridge. It's idempotent, so you can
re-run it any time the phone reboots or the u2 server dies.

Generate `<BRIDGE_TOKEN>` by running this in your browser console
while signed in to https://folia-inventory.vercel.app/ :

```js
fetch('/api/bridge?action=generate-token', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    action: 'generate-token',
    userId: JSON.parse(localStorage.getItem('session-current-user')).id,
  }),
}).then(r => r.json()).then(console.log)
```

⚠️ Generating a new token instantly kicks any other running bridge
offline. If you want two Macs to be able to take over from each
other, copy the same `.env` to both — but **only run one bridge at
a time** to avoid jobs racing between them.

## Manual setup (if you want to know what `setup.sh` does)

1. **Install ADB**
   ```bash
   brew install android-platform-tools
   ```
2. **Enable USB debugging on the phone**: Settings → About → tap "Build
   number" 7 times → back → Developer Options → USB debugging.
3. **Plug in the phone**, run `adb devices`, accept the auth prompt on
   the phone screen.
4. **(Optional but recommended) Wireless ADB** so you can ditch the
   cable during a live:
   ```bash
   adb tcpip 5555
   adb connect <phone-ip>:5555
   ```
5. **Generate a bridge token.** Open the Folia web app, sign in, and
   POST to `/api/bridge?action=generate-token` (this gets wired into a
   settings button in Phase 3). The response contains a one-time
   `token` — copy it now; it's not recoverable.
6. **Create `bridge/.env`**:
   ```
   FOLIA_API_URL=https://foliainventory.vercel.app
   BRIDGE_TOKEN=<paste the token>
   # BRIDGE_DEVICE=<adb-serial>     # only if multiple devices are connected
   # POLL_MS=500
   # U2_URL=http://localhost:9008   # or "off" to disable
   ```

7. **Install the uiautomator2 server.** The bridge uses uiautomator2's
   on-device server for fast UI dumps (~280 ms vs ~2 s for `adb shell
   uiautomator dump`). Without it the bridge still works, just ~3×
   slower per scan.

   ```bash
   pip3 install --user --break-system-packages uiautomator2
   python3 -m uiautomator2 init    # pushes server jar to the phone
   ```

   The server runs as a detached process on the phone. After the phone
   reboots it has to be relaunched:
   ```bash
   adb shell "nohup sh -c 'CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main' > /dev/null 2>&1 &"
   adb forward tcp:9008 tcp:9008
   ```
   Test with `curl http://localhost:9008/ping` — should print `pong`.

## Run (wireless, one command)

After first-time setup, this is the only command you need each session:

```bash
cd bridge && npm start
```

`npm start` runs `./start.sh`, which:

1. **Reconnects wirelessly** — short-circuits when `adb devices`
   already shows an `ip:port device`, falls back to mDNS discovery,
   then to the saved target (with a `:5555` legacy-mode retry).
2. **Sets up the `tcp:9008` forward** so the bridge can talk to the
   on-device u2 server, and verifies u2 is responding (relaunches
   it if it crashed since the last session).
3. **Pins `BRIDGE_DEVICE` to the wireless target** — without this
   every adb call would fail with "more than one device/emulator"
   when the phone is also plugged in via USB.
4. **Starts the bridge poller** (`node index.js`).

If the phone is plugged into USB and you'd rather skip the wireless
dance, run `npm run serve` (pure `node index.js`) instead.

Output looks like:

```
Folia bridge starting
  api    https://foliainventory.vercel.app
  device (default adb device)
  poll   500ms
  adb    1 device(s): RFCT80XYZ device
```

It runs until Ctrl-C. Restarting the bridge is safe — jobs that were
mid-flight automatically expire after 60 s and get re-claimed.

## Architecture notes

- **No dependencies.** Pure Node + native `fetch`. Whole bridge is one
  file; nothing to `npm install`.
- **Token, not server.** The bridge identifies itself by its bearer
  token. Rotating the token via `generate-token` instantly kicks any
  running bridge offline.
- **At-least-once delivery.** If the bridge crashes mid-job, the job
  goes stale after 60 s and another (or restarted) bridge picks it up.
  Make job handlers idempotent where it matters.
- **Backoff.** API errors (offline, token revoked, Vercel cold start)
  back off up to 30 s before retrying.

## Job actions

The bridge currently handles these `action` values posted to
`/api/bridge?action=enqueue`:

| action    | payload                                    | result                                |
| --------- | ------------------------------------------ | ------------------------------------- |
| `tap`     | `{x,y}` _or_ `{resourceId}` _or_ `{text}`  | `{tapped: {x,y} or {bounds}}`         |
| `type`    | `{text}`                                   | `{length}`                            |
| `dump`    | _none_                                     | `{xml}` (current UI tree)             |
| `listing` | `{sku, name, price}` _(Phase 2 stub)_      | `{stub: true, ...}`                   |

Phase 2 will replace the `listing` handler with the scripted Palmstreet
"add listing during live" flow.
