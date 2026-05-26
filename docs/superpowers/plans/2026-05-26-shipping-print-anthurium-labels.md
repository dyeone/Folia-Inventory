# Shipping — Print Anthurium Labels in Open Boxes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new buttons in the Shipping tab's Ready view — one per open box and one at the tab header — that print 2″×1″ thermal labels for every Anthurium item in scope, reusing the existing `LabelSheet` portal.

**Architecture:** No new components. The existing label-print infrastructure (`App.jsx:191` `labelItems` state + `App.jsx:1373–1374` `<LabelSheet>` portal) is already wired up for the inventory tab; we expose the same callback to `<PackingView>` and call it from two new buttons. The Anthurium predicate matches the existing usage at `src/labels/BoxLabelSheet.jsx:67`: `(i.variety || '').toLowerCase() === 'anthurium'`.

**Tech Stack:** React 19, Vite, Tailwind, `lucide-react`. **No test runner** is installed — verification is `npm run lint` + manual browser checks per task. Each task ends with lint + a manual checklist + commit, same rhythm as the earlier purchase-tab plan.

**Spec:** `docs/superpowers/specs/2026-05-26-shipping-print-anthurium-labels-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/App.jsx` | Modify | Pass `onPrintItemLabels={(items) => setLabelItems(items)}` to the `<PackingView>` mount. One-line addition. |
| `src/packing/PackingView.jsx` | Modify | Accept the new prop; add the tab-level "Print ANT labels (N)" button in the Ready-tab header next to the existing "Print box labels"; forward the prop to `<ShipBoxCard>`. |
| `src/packing/ShipBoxCard.jsx` | Modify | Accept the new prop; render a per-box "Print ANT labels" button in the action row, hidden when the box has no Anthurium items. |

Three files. No new components, no new label format, no new API, no DB change.

---

## Task 1: App.jsx — expose `onPrintItemLabels` to PackingView

**Files:**
- Modify: `src/App.jsx` (the `<PackingView>` mount, currently around lines 913–922)

`App.jsx` already declares `const [labelItems, setLabelItems] = useState(null);` (line 191) and renders the `<LabelSheet items={labelItems} onClose={() => setLabelItems(null)} />` portal (lines 1373–1374) for the inventory tab's print-label flow. The change here is just exposing `setLabelItems` as a new prop on `<PackingView>` so the shipping tab can drive the same portal.

- [ ] **Step 1: Add the prop to the `<PackingView>` mount**

Open `src/App.jsx` and find the `<PackingView` mount (currently inside the `{activeTab === 'packing' && ...}` block, ~line 913). Insert a new prop on its own line, immediately after the existing `onPrintBoxLabels={(boxes) => setBoxLabelBoxes(boxes)}` line:

```jsx
            onPrintBoxLabels={(boxes) => setBoxLabelBoxes(boxes)}
            onPrintItemLabels={(items) => setLabelItems(items)}
```

That's the entire change — `<LabelSheet>` is already mounted and `setLabelItems` is already in scope.

- [ ] **Step 2: Lint**

Run: `npm run lint`

Expected: no new errors in `src/App.jsx`. (Pre-existing errors in `mac-app/dist/...` and `bridge/...` Node-context files are unrelated and fine.)

Verify with: `npm run lint 2>&1 | grep -E "src/App\.jsx" || echo "(no issues in App.jsx)"`

- [ ] **Step 3: Commit**

```bash
git add src/App.jsx
git commit -m "$(cat <<'EOF'
shipping: expose onPrintItemLabels to PackingView

The existing labelItems state + <LabelSheet> portal already drive
inventory's print-label flow. Pass the same setter through to the
packing view so the shipping tab can light up the same portal for
the upcoming per-box / tab-level Anthurium-print buttons.
EOF
)"
```

---

## Task 2: PackingView.jsx — accept prop + tab-level button + forward to card

**Files:**
- Modify: `src/packing/PackingView.jsx` — three edits in the same file

This task adds the tab-level "Print ANT labels (N)" button to the Ready-tab header and forwards the prop down to each `<ShipBoxCard>`. The button label includes a live count of Anthurium items across the *currently-visible* open boxes (after any filter/sort already applied) and is disabled when the count is zero.

- [ ] **Step 1: Accept the new prop in the function signature**

Find the destructured-props block in `src/packing/PackingView.jsx`. It currently starts around line 60 with:

```jsx
  onShipBox, onDeleteAllOpenBoxes, onDeleteBox, onPrintBoxLabels, onTogglePacked,
```

Add `onPrintItemLabels` to that list:

```jsx
  onShipBox, onDeleteAllOpenBoxes, onDeleteBox, onPrintBoxLabels, onPrintItemLabels, onTogglePacked,
```

- [ ] **Step 2: Add the tab-level button to the Ready-tab header**

Find the existing "Print box labels" button block in the same file (currently around lines 672–693). It's wrapped in `{totalBoxes > 0 && onPrintBoxLabels && (...)`. Immediately after the closing `)}` of that block — and still inside the same wrapping flex container — insert the new tab-level button:

```jsx
                {onPrintItemLabels && (() => {
                  // Count Anthurium items across the currently-visible
                  // open boxes (after any sort/filter already applied
                  // upstream). Same predicate the box-label header uses
                  // (src/labels/BoxLabelSheet.jsx).
                  const allBoxes = groups.flatMap(g => g.boxes);
                  const antItems = allBoxes.flatMap(b =>
                    (b.items || []).filter(i => (i.variety || '').toLowerCase() === 'anthurium')
                  );
                  const n = antItems.length;
                  return (
                    <button
                      type="button"
                      disabled={n === 0}
                      onClick={() => onPrintItemLabels(antItems)}
                      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Printer className="w-4 h-4" />
                      Print ANT labels
                      <span className="text-xs text-gray-400 ml-1">· {n}</span>
                    </button>
                  );
                })()}
```

(The `Printer` icon is already imported at the top of the file via the existing `lucide-react` import — see the "Print box labels" button uses the same icon.)

- [ ] **Step 3: Forward the prop to `<ShipBoxCard>`**

Find the `<ShipBoxCard` mount in the same file (currently around line 1774). Add the new prop to the JSX (no replacement of existing props — just add one line). The mount currently has props like `box={...}` `shipment={...}` `onShip={...}` etc.; add this prop line alongside them:

```jsx
            onPrintItemLabels={onPrintItemLabels}
```

- [ ] **Step 4: Lint**

Run: `npm run lint`

Verify with: `npm run lint 2>&1 | grep -E "packing/PackingView\.jsx" || echo "(no issues)"`

Expected: `(no issues)`

- [ ] **Step 5: Manual browser verification**

Run `npm run dev` if it isn't already running, then in the browser:

1. Open Shipping → Ready tab.
2. Confirm the new **"Print ANT labels · N"** button appears in the header, immediately after "Print box labels".
3. The count `N` matches the total Anthurium items across the visible open boxes.
4. Click it → the LabelSheet print dialog opens with one 2″×1″ label per Anthurium item.
5. With no Anthurium-containing boxes visible (e.g. apply a filter that excludes them), confirm `N` is `0` and the button is visibly disabled.
6. Switch to the Shipped tab — confirm the button is no longer shown (the existing `activeTab === 'ready'` gating on the header should already handle this; if the button appears on the Shipped tab, move its insertion site inside the Ready-tab branch).

- [ ] **Step 6: Commit**

```bash
git add src/packing/PackingView.jsx
git commit -m "$(cat <<'EOF'
shipping: tab-level Print ANT labels button in Ready header

Walks every visible open box, filters items by variety='anthurium'
(case-insensitive, matching BoxLabelSheet's predicate), and hands
the list to the existing LabelSheet portal via onPrintItemLabels.

Label shows the count inline ("Print ANT labels · N"); button is
disabled when N is 0. Also forwards onPrintItemLabels down to
each ShipBoxCard so the per-box button (next commit) can use it.
EOF
)"
```

---

## Task 3: ShipBoxCard.jsx — per-box button in the action row

**Files:**
- Modify: `src/packing/ShipBoxCard.jsx`

Add a "Print ANT labels" button to the bottom action row that already houses Buy UPS Label / Add USPS Tracking / Mark Shipped. The button is hidden when the box has zero Anthurium items so non-Anthurium box cards stay uncluttered.

The card's action row only renders when `!allShipped && !editingTracking`, which already constrains the button to open boxes — no extra gating needed.

- [ ] **Step 1: Accept the new prop in the function signature**

Find the `ShipBoxCard` function declaration in `src/packing/ShipBoxCard.jsx` (currently around line 46–50). It looks like:

```jsx
export function ShipBoxCard({
  box, shipment, showToast,
  onShip,
  onBuyLabel, onVoidLabel,
  onSaveTracking, onClearTracking,
}) {
```

Change it to add the new prop:

```jsx
export function ShipBoxCard({
  box, shipment, showToast,
  onShip,
  onBuyLabel, onVoidLabel,
  onSaveTracking, onClearTracking,
  onPrintItemLabels,
}) {
```

- [ ] **Step 2: Add the `Printer` icon to the import block**

Find the `lucide-react` import line near the top of the file. The existing icons probably include `Send`, `ShoppingCart`, `Tag`, `Edit2`, `RotateCcw`, `DownloadIcon`. Add `Printer` to that import list. For example:

```jsx
import { Send, ShoppingCart, Tag, Edit2, RotateCcw, Download as DownloadIcon, Printer } from 'lucide-react';
```

(Match the existing import style — preserve whatever the file already uses; just add `Printer`.)

- [ ] **Step 3: Render the per-box button in the action row**

Find the action-button row inside `ShipBoxCard.jsx` — the `<div className="px-4 py-3 bg-gray-50 border-t border-gray-100 flex justify-end gap-2 flex-wrap">` block (currently around line 283), inside the `{!allShipped && !editingTracking && (...)}` gate.

Insert the new button as the **first** child of that flex container so it sits to the left of Buy/Add-Tracking/Mark-Shipped:

```jsx
              {onPrintItemLabels && (() => {
                // Same predicate as the tab-level button and the
                // BoxLabelSheet header tag (src/labels/BoxLabelSheet.jsx).
                const antItems = (box.items || []).filter(
                  i => (i.variety || '').toLowerCase() === 'anthurium'
                );
                if (antItems.length === 0) return null;
                return (
                  <button
                    type="button"
                    onClick={() => onPrintItemLabels(antItems)}
                    className="flex items-center gap-1.5 px-4 py-2.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium rounded-lg"
                    title={`Print 2″×1″ labels for the ${antItems.length} Anthurium item${antItems.length === 1 ? '' : 's'} in this box`}
                  >
                    <Printer className="w-4 h-4" />
                    Print ANT labels
                    <span className="text-xs text-gray-500 ml-0.5">· {antItems.length}</span>
                  </button>
                );
              })()}
```

- [ ] **Step 4: Lint**

Run: `npm run lint`

Verify with: `npm run lint 2>&1 | grep -E "packing/ShipBoxCard\.jsx" || echo "(no issues)"`

Expected: `(no issues)`

- [ ] **Step 5: Manual browser verification**

In the dev-server browser:

1. Open Shipping → Ready tab.
2. Find a box card that contains at least one Anthurium item. Confirm the **"Print ANT labels · N"** button is present in the bottom action row, to the left of Buy/Add-Tracking and Mark-Shipped.
3. Click it → LabelSheet opens with exactly that box's Anthurium item labels (count matches N).
4. Find a box card that has no Anthurium items. Confirm the per-box button is **not** present on that card (other action buttons still render normally).
5. Find a shipped box (Shipped tab). Confirm no action row + no per-box button (existing `!allShipped` gating handles this; if it leaks through, move the button inside that gate).
6. Re-verify the tab-level button from Task 2 still works.

- [ ] **Step 6: Commit**

```bash
git add src/packing/ShipBoxCard.jsx
git commit -m "$(cat <<'EOF'
shipping: per-box Print ANT labels button on open-box cards

Sits in the action row alongside Buy Label / Add Tracking / Mark
Shipped, hidden when the box has zero Anthurium items (so cards
without Anthuriums stay uncluttered). Uses the same predicate and
the same LabelSheet portal as the tab-level Ready-header button.
EOF
)"
```

---

## Self-review notes

**Spec coverage:**
- Per-box button on `ShipBoxCard` hidden when no Anthuriums → Task 3 Step 3 ✓
- Tab-level button in Ready-tab header with live count, disabled at 0 → Task 2 Step 2 ✓
- Anthurium predicate matches existing usage → both Task 2 and Task 3 inline the same `(i.variety || '').toLowerCase() === 'anthurium'` check ✓
- Reuse existing `LabelSheet` portal → Task 1 wires `setLabelItems` straight through ✓
- No status filter — every Anthurium regardless of status → both buttons filter only by variety ✓
- Open-boxes only — Shipped tab unaffected → ShipBoxCard's existing `!allShipped` gate (Task 3) + Ready-tab gating on header (Task 2) ✓
- Buyer → box → SKU ordering → falls out of `groups.flatMap(g => g.boxes)` → `.flatMap(b => b.items.filter(...))` since both arrays are already sorted by the existing PackingView code ✓
- No new label format, DB change, or API → confirmed by file map ✓

**Type / name consistency:**
- Prop name `onPrintItemLabels` is identical across App.jsx → PackingView.jsx props → PackingView.jsx forward → ShipBoxCard.jsx props. ✓
- Callback signature is `(items: array) => void` everywhere; the portal expects a non-empty array (`labelItems && labelItems.length > 0` guard at App.jsx:1373). Both buttons short-circuit before calling when their count is 0 (disabled-button click prevented; per-box button returns `null` and never renders). ✓

**Placeholder scan:** No TBDs, no "implement later", every code-changing step includes the exact code. ✓
