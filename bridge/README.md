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

## One-time setup

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
   # POLL_MS=1500
   ```

## Run

```bash
cd bridge
npm start
```

Output looks like:

```
Folia bridge starting
  api    https://foliainventory.vercel.app
  device (default adb device)
  poll   1500ms
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
