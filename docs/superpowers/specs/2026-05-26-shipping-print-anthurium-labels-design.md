# Shipping tab — print all Anthurium labels in open boxes

**Date:** 2026-05-26
**Scope:** `src/packing/` + a small wiring change in `src/App.jsx`

## Problem

During a live-sale shipping shift, the operator wants to pre-print a label for every Anthurium that's about to ship. Anthuriums get extra handling (the `ANT` tag on box-label headers — commit `c356d25` — is the existing acknowledgement) and the operator wants the item labels in hand before opening each box. Today there's no batch operation for this; the operator has to walk through boxes and bulk-select items, which is slow and error-prone.

## Goals

- One click prints Anthurium labels for a single open box.
- One click prints Anthurium labels for **every** open box visible in the Ready tab.
- Reuse the existing 2″×1″ item-label format (`src/labels/LabelSheet.jsx`).

## Non-goals

- No new label layout. Same `LabelSheet` component as inventory bulk-print.
- No new filter UI (no "all Philodendrons", no custom predicates). Anthurium-only.
- No DB schema change, no new API endpoint.
- No save-to-file flow — same browser print dialog as the existing label paths.
- No button in the Shipped tab. This is a pre-handoff aid for open boxes only.

---

## Design

### Anthurium predicate

Same check the existing code uses (`BoxLabelSheet.jsx:67`, `BoxContentBadges.jsx:16`):

```js
const isAnthurium = (i) => (i.variety || '').toLowerCase() === 'anthurium';
```

No status filter — per the brainstorming pass, every Anthurium in the box gets a label regardless of `status` (sold / refunded / acclimated / converted). The operator wants physical labels for the physical items in the box.

### Per-box button

Lives in `ShipBoxCard.jsx`, in the same action row as `Mark shipped` / `Print box label`. Label: **"Print ANT labels"**. Hidden when `box.items.filter(isAnthurium).length === 0` (keeps the card clean on non-Anthurium boxes — the existing `BoxContentBadges` already shows whether a box has Anthuriums).

On click:

```js
const items = box.items.filter(isAnthurium);
onPrintItemLabels(items);
```

`onPrintItemLabels` is a new prop on `ShipBoxCard`, threaded through `PackingView` from `App.jsx`.

### Tab-level button

Lives in `PackingView.jsx`, in the Ready-tab header next to the existing **"Print box labels"** button (around line 672–688 — the spot guarded by `totalBoxes > 0 && onPrintBoxLabels`). Always rendered when the Ready tab is active. Label includes the live count:

> **Print ANT labels (N)**

Where `N` is the total Anthurium item count across every box currently visible in the Ready tab (after any existing filters the user has applied — variety filter, carrier filter, sort, etc.). Button is disabled when `N === 0`.

On click:

```js
const items = readyBoxes
  .flatMap(b => b.items.filter(isAnthurium));
onPrintItemLabels(items);
```

Order is buyer → box → SKU so the printed sheet matches on-screen grouping. The buyer/box ordering falls out of `flatMap` over the already-sorted `readyBoxes` array; within each box, items are already in SKU order in the box-items list.

### App-level wiring

The infrastructure exists. `App.jsx:191` declares `const [labelItems, setLabelItems] = useState(null)`; the `<LabelSheet>` portal at `App.jsx:1373–1374` renders whenever `labelItems` is a non-empty array. The inventory tab already calls `setLabelItems(...)` via `onPrintLabel` / `onBulkPrintLabel` props (`App.jsx:821–822`).

The change: pass a new prop `onPrintItemLabels={(items) => setLabelItems(items)}` to `<PackingView>`. `PackingView` forwards it to `ShipBoxCard` for the per-box button and uses it directly for the tab-level button.

No state duplication. Same portal, same close handler, same PDF/print flow.

### Empty cases

| Scenario | Per-box button | Tab-level button |
|----------|----------------|------------------|
| Box has 0 Anthuriums | Hidden | (unaffected — counts other boxes) |
| Ready tab has 0 Anthuriums total | (button hidden per-box) | Visible, label `Print ANT labels (0)`, **disabled** |
| Ready tab has 0 boxes | (no cards rendered) | Visible, label `Print ANT labels (0)`, **disabled** |
| Active tab is "Shipped" | Not rendered | Not rendered |

---

## Files touched

| File | Action |
|------|--------|
| `src/App.jsx` | Add `onPrintItemLabels={setLabelItems}` to the `<PackingView>` mount. |
| `src/packing/PackingView.jsx` | Accept `onPrintItemLabels` prop; add tab-level button to the Ready-tab header; forward the prop to `<ShipBoxCard>`. |
| `src/packing/ShipBoxCard.jsx` | Accept `onPrintItemLabels` prop; render per-box "Print ANT labels" button (hidden when no Anthurium items in the box). |

Three files. No new components, no new label format, no new API.

## Testing

UI-only — no test runner in this project. Manual checks against the dev server:

1. Open Shipping → Ready tab. Confirm "Print ANT labels (N)" appears in the header where N matches the sum of Anthurium items across visible boxes.
2. Click it → LabelSheet print dialog opens with one 2″×1″ label per Anthurium item; ordering matches on-screen buyer → box → SKU.
3. On a box card that contains an Anthurium, confirm the per-box "Print ANT labels" button appears next to "Print box label".
4. Click it → only that box's Anthurium item labels print.
5. On a box card with no Anthurium items, confirm the per-box button is absent.
6. With filters applied (e.g. variety filter excluding Anthurium → no Anthurium boxes visible), confirm the tab-level count drops to 0 and the button disables.
7. Switch to the Shipped tab — confirm the tab-level button is not rendered there.
