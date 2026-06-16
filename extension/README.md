# Folia Label Helper (Chrome extension)

Drives Palmstreet's USPS label-purchase flow from a Folia work queue.
Reads the box weight from a USB postal scale, captures the shipping
label + packing slip PDFs, and syncs the tracking number back to Folia
Inventory — all without manually retyping anything.

## Flow

The extension automates this 8-step Palmstreet sequence per order:

1. Open the "ready to ship" orders list
2. Search by buyer username
3. Select the matching order, click Continue
4. Type the weight (read from the USB scale)
5. Click Purchase Label
6. Click Pay
7. Capture the **shipping label** PDF
8. Capture the **packing slip** PDF

After that, it POSTs the tracking number + both PDFs to Folia, where
they show up on the box in the Packing tab. A separate **Sync tracking
only** mode skips the click sequence and just reads tracking numbers
already visible on the page — useful for orders you've labeled manually.

### Push tracking → Palmstreet (reverse direction)

When you buy labels outside Palmstreet (e.g. Shippo/Pirate Ship) and
import them into Folia, use the **Has tracking** tab → **Add tracking →
Palmstreet**. For each selected box it:

1. Searches the orders list by **recipient name**
2. Selects the matching order
3. Opens the add-tracking form (optional step), picks USPS (optional)
4. Types the tracking number Folia already has for that box
5. Saves

The queue comes from `GET /api/shipments?action=with-tracking` (boxes
that have a recorded tracking number). Configure the four
**Push tracking to Palmstreet** selectors in Settings; blank optional
ones are skipped so the flow fits Palmstreet's actual UI.

## Install

1. Clone this repo so the `extension/` folder is on disk.
2. `chrome://extensions` → toggle **Developer mode** (top right) → **Load unpacked** → pick the `extension/` folder.
3. Pin the leaf icon to your toolbar.

Re-load the extension after edits via the refresh icon on its card on
the extensions page.

## First-time setup

Open the extension → click ⚙︎ to open Settings. You'll fill in three
groups: API, selectors, scale.

### Folia API

| Field | What |
|---|---|
| API base URL | e.g. `https://your-app.vercel.app` (no trailing slash) |
| User ID | From the Folia app: DevTools → Application → Local Storage → `session-current-user` → copy `id` |

### Palmstreet selectors

The extension doesn't ship with hard-coded Palmstreet selectors; you
teach it once by inspecting Palmstreet's UI:

> Right-click the element → Inspect → in DevTools right-click the
> highlighted node → Copy → **Copy selector**. Paste into the matching
> Settings field.

**Targeting a button by its words.** Palmstreet's buttons (Continue, Pay,
Add tracking, Save…) often have no stable CSS hook. Instead of a CSS
selector, use `text=Continue` (matches the button whose text is exactly
"Continue") or `text*=Add track` (text *contains*). This replaces CSS
`:contains()`, which is jQuery-only and doesn't work in the browser.

You need 11 selectors (8 mandatory, 3 optional):

| Step | Setting | What to point at |
|---|---|---|
| 1 | "Open shipping" | The link/button on Palmstreet's main page that takes you to the orders-to-ship list |
| 2 | Search input | The text box you'd normally type a username into to filter the list |
| 3a | Order row | One element per matching order (the extension clicks the first match for the searched username) |
| 3b | Continue | The Continue button after selecting an order |
| 4 | Weight input | The numeric input where the box weight goes |
| 5 | Purchase label | The button that opens payment confirmation |
| 6 | Pay | The button that actually charges |
| 7 | Shipping label link | An `<a href>` to the label PDF (the extension fetches the URL, doesn't click+open) |
| 8 | Slip link | An `<a href>` to the packing-slip PDF |
| — | Tracking text | Where the tracking number appears post-purchase |
| — | Back-to-list | Optional — clicked between orders to return to the search list |

If Palmstreet redesigns their UI, update the selectors here — no code
release needed.

### Scale

1. Plug your USB postal scale in.
2. **Pair scale** in Settings → pick your scale from Chrome's device picker.
3. Click **Read once** to confirm it returns a weight.

Compatible with HID-class postal scales (DYMO M10/M25, Stamps.com 510,
generic POS scales). When the queue runs, the popup reads the scale
fresh before each weight entry; if the scale isn't responding, it
prompts you to type the weight (or uses the configured default).

### Behavior

- **Confirm before each order** — keeps you in the loop. Recommended.
- **Random delay** — pause between actions so the activity doesn't look like a bot. `800–2000` ms.
- **Per-step timeout** — how long to wait for each next-step element to appear before aborting that order. `20000` ms is reasonable.

## Usage

1. Open Palmstreet in the active tab.
2. Click the extension icon. The popup fetches the queue of USPS boxes
   waiting for labels from Folia.
3. Uncheck any boxes you don't want to process.
4. Click **Buy + sync selected** to run the full 8-step flow per box,
   or **Sync tracking only** to just scrape tracking numbers from the
   current page.
5. The progress section shows each order as it's processed; click
   **Stop** to halt the queue.

To push externally-bought tracking numbers into Palmstreet instead,
switch to the **Has tracking** tab and click **Add tracking →
Palmstreet** (searches each order by recipient name and fills in the
tracking number Folia already stored).

After purchase, the box on Folia's Packing tab shows tracking + a
**Label** download button (signed URL to Storage) + a **Slip** button.

## How tracking lands in Folia

```
POST /api/shipments
{
  "action": "record-tracking",
  "shipmentBoxId": "box_abc",
  "trackingNumber": "9400 1112 0204 1234 5678 90",
  "weightOz": 28.5,
  "labelPdfBase64": "<binary>",
  "slipPdfBase64":  "<binary>",
  "userId": "..."
}
```

The server uploads both PDFs to the `shipping-labels` Storage bucket and
upserts a `shipments` row tagged `carrierCode = palmstreet`. The
PackingView in Folia picks this up on its next refresh.

## Troubleshooting

- **"Open Palmstreet in this tab"** — the popup only enables on `*.palmstreet.app` / `*.palmstreet.com` tabs.
- **"Timed out waiting for [selector]"** — that step's selector either
  doesn't match anything or Palmstreet hadn't loaded the next screen
  yet. Re-inspect the page, paste a fresh selector in Settings.
- **"No matching order row for X"** — Palmstreet's search returned no
  results for that buyer username. Check that the order actually exists
  on the orders page and that the `Order row` selector targets the
  right element.
- **"Shipping label has no href to fetch"** — the label element isn't
  an `<a>` with an href. It might be a button that triggers download.
  In that case the current capture method won't work; report back so we
  can add a download-interception path.
- **PDFs aren't appearing in Folia** — the `shipping-labels` Storage
  bucket might not exist. Create it (private) in Supabase Dashboard →
  Storage → New bucket. The tracking number is saved either way.

## Limitations & risks

- Chromium-only (Chrome / Edge / Brave). WebHID isn't on Firefox or Safari.
- Palmstreet may treat fast/repeated clicking as automation. Keep
  random delays generous and confirm-per-order on. The extension is
  not officially endorsed by Palmstreet — use at your own risk.
- A failed step aborts that one order cleanly (no half-purchased
  state) but the queue continues with the next box. Stopping mid-flight
  is one click away.
