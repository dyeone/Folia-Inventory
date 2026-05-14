# Folia ADB Bridge

Local helper that lets the Folia web app drive an Android phone over ADB.
Runs on the operator's Mac during a live sale; never deployed.

## One-time setup

1. Install ADB:
   ```
   brew install android-platform-tools
   ```
2. On the phone: Settings → About → tap "Build number" 7 times → back to
   Settings → Developer Options → enable USB debugging.
3. Plug the phone in via USB; run `adb devices` and accept the auth prompt
   on the phone screen.
4. (Optional but recommended) Wireless ADB so you can ditch the cable
   during a live:
   ```
   adb tcpip 5555
   adb connect <phone-ip>:5555
   ```

## Run

```
cd bridge
npm install
BRIDGE_SECRET=somelongstring npm start
```

The bridge prints both `localhost` and your LAN URLs at startup. Point
the Folia app's "Bridge URL" setting at one of the LAN addresses if
you're driving from an iPad / phone.

### Environment variables

| var             | default | meaning                                                       |
| --------------- | ------- | ------------------------------------------------------------- |
| `BRIDGE_PORT`   | `7755`  | TCP port to bind                                              |
| `BRIDGE_SECRET` | _none_  | Required `Authorization: Bearer …` token (none = open access) |
| `BRIDGE_DEVICE` | _none_  | adb serial when more than one device is connected             |

## Endpoints

| method | path        | purpose                                                          |
| ------ | ----------- | ---------------------------------------------------------------- |
| GET    | `/health`   | Bridge alive + visible adb devices (no auth)                     |
| POST   | `/tap`      | `{x,y}` or `{resourceId}` or `{text}` — tap on phone             |
| POST   | `/type`     | `{text}` — type into focused field                               |
| GET    | `/dump`     | Current UI XML — used during Phase 2 discovery                   |
| POST   | `/listing`  | `{sku?, name, price}` — Phase 1: queues. Phase 2: pushes to live |
| GET    | `/queue`    | All queued listings                                              |

All non-`/health` endpoints require `Authorization: Bearer $BRIDGE_SECRET`
when `BRIDGE_SECRET` is set.

## Verifying it works (without Palmstreet)

```
# Terminal 1
npm start

# Terminal 2
curl http://localhost:7755/health
# → { ok: true, adbDevices: [{ serial, status }] }

curl -X POST http://localhost:7755/tap \
  -H "Authorization: Bearer $BRIDGE_SECRET" \
  -H "content-type: application/json" \
  -d '{"x": 540, "y": 1500}'
# → screen taps at 540,1500

curl http://localhost:7755/dump \
  -H "Authorization: Bearer $BRIDGE_SECRET" > ui.xml
# → seed data for Phase 2 selector discovery
```

## Known constraints

- **HTTPS / mixed-content**: Folia is served over HTTPS (Vercel) but the
  bridge speaks HTTP, so Safari/Chrome will block fetches to it from the
  deployed app. Phase 3 options: (a) run the Folia dev server on the
  same Mac and access it over LAN HTTP, (b) front the bridge with a
  self-signed TLS cert and trust it once on the iPad, (c) tunnel via
  ngrok/cloudflared. Decision deferred to Phase 3.
- **Single host**: queue is in-memory; restarting the bridge drops
  unprocessed entries. Acceptable for live-sale scope.
