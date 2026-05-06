# Folia Label Helper (Chrome extension)

A small helper that lets you batch-process Palmstreet USPS labels and
sync the tracking numbers back to Folia Inventory without retyping them.

Two modes:

| Mode | What it does | Risk |
|---|---|---|
| **Sync tracking only** | Reads the tracking numbers already visible on a Palmstreet orders page and POSTs them to Folia. No clicks. | Almost none — same as you reading the page. |
| **Buy + sync** | Clicks the "Buy label" button on each order, waits for the tracking to appear, then syncs. Random delay between orders, optional confirmation per click. | Higher — looks like automation, can trip Palmstreet's bot defenses. Use sparingly. |

## Install

1. Clone or download this repo so you have the `extension/` folder on disk.
2. Open Chrome → `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** → pick the `extension/` folder.
5. The Folia leaf should appear in your toolbar. (Pin it for easy access.)

## First-time setup

Open the extension, hit ⚙︎ to open Settings, then fill in:

### Folia API
- **API base URL** — e.g. `https://your-app.vercel.app` (no trailing slash).
- **User ID** — your Folia user id. Find it by:
  1. Open the Folia app in another tab, log in.
  2. DevTools → Application → Local Storage → entry `session-current-user`.
  3. Copy the `id` value.

### Palmstreet selectors
The extension doesn't know Palmstreet's HTML. You teach it once by filling
in CSS selectors for these elements:

| Field | What to point at |
|---|---|
| Order row | The repeating element on the orders list — one per order. |
| Order ID inside an order row | The text element holding Palmstreet's order number. |
| "Buy label" button | The button that purchases the label, inside a row. |
| Tracking number text | Where the tracking number appears once a label exists. |
| Already-purchased indicator (optional) | Anything that signals "label already bought". |

**How to find a selector**: open Palmstreet's orders page → right-click the
element → Inspect → in DevTools, right-click the highlighted node → Copy →
**Copy selector**. Paste into the matching field in the extension's Settings.

You only need to set this up once. Re-do it if Palmstreet ever redesigns
their orders page.

### Behavior
- **Confirm before each Buy** — leave on while you're getting comfortable;
  the extension will ask before each click.
- **Random delay** — pause between orders. `800–2000` ms is reasonable;
  longer is safer-looking.

Click **Save**.

## Usage

1. Open Palmstreet, navigate to your orders/shipments page.
2. Click the extension icon in the toolbar.
3. The popup shows how many orders it sees on the page.
4. Click **Sync tracking only** to read whatever tracking is already
   visible and push it to Folia.
5. Click **Buy + sync** to also click the Buy button (gated by your
   per-order confirmations).

The popup logs each order as it goes; **Stop** halts the queue.

## How tracking lands in Folia

The extension POSTs to `POST /api/shipments` with:
```json
{
  "action": "record-tracking",
  "matchByOrderId": "<palmstreet order #>",
  "trackingNumber": "<scraped value>",
  "userId": "<your user id>"
}
```
Folia looks up which inventory items have that `orderId`, finds their
`shipmentBoxId`, and upserts a `shipments` row tagged
`carrierCode = palmstreet`. The Packing tab will show the tracking next
to the box on the next refresh.

## Troubleshooting

- **"Open Palmstreet's orders page"** — the popup only enables itself on
  `*.palmstreet.app` / `*.palmstreet.com` tabs.
- **"0 orders detected"** — the **Order row** selector isn't matching
  anything. Re-inspect the page and update the selector.
- **"Buy button not found in this row"** — same issue, but for
  **Buy label button**. The button might be hidden until you hover, or
  Palmstreet might use different markup for paid vs. unpaid orders.
- **"No shipment box found for Palmstreet order …"** — this Palmstreet
  order isn't linked to any inventory item in Folia. Make sure the sale's
  Palmstreet orders file has been uploaded in the Sales tab first.

## Limitations

- The extension only works in Chrome / Edge / Brave (any Chromium browser).
- Palmstreet's web UI can change. When it does, you update the selectors
  in Settings — no code release needed.
- The Buy + sync mode does the riskiest thing: clicking purchase buttons.
  If Palmstreet's bot defenses ever flag your account, that's on you, not
  on Folia. Keep the random delay generous and confirm-per-click on until
  you trust the flow.
