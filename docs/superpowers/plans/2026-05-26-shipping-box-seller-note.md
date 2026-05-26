# Shipping — Seller's Note on Open Box — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operator can attach a free-text note to any open box from the ShipBoxCard detail view; the note persists in a new `shipment_boxes` table, is internal-only (never printed), and auto-loads on the drill-down view.

**Architecture:** A "box" is currently a virtual entity (items sharing `shipmentBoxId`). We elevate it to a row via a new lightweight `shipment_boxes` table keyed by that id, lazy-created on first save. A new POST action + GET action on the existing `/api/shipments` endpoint handle write and read. The UI lives entirely in `ShipBoxCard.jsx`; data flows via a new `boxNotesByBox` state in `PackingBoxesPane` fetched in parallel with shipments.

**Tech Stack:** Supabase (Postgres + REST), Vercel Functions (Node), React 19, Vite, Tailwind, `lucide-react`. **No test runner** is installed — verification is `npm run lint` + manual browser checks per task, same rhythm as prior plans this session.

**Spec:** `docs/superpowers/specs/2026-05-26-shipping-box-seller-note-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/0018_shipment_boxes.sql` | Create | New table — lazy-created box-level metadata. |
| `supabase/schema.sql` | Modify | Append the same `create table if not exists shipment_boxes` block + RLS toggle in the post-`shipments` section so the snapshot stays canonical. |
| `api/shipments.js` | Modify | Add `set-box-note` POST action and `box-notes` GET action. |
| `src/api.js` | Modify | Add `setBoxNote({ shipmentBoxId, note })` and `getBoxNotes(saleId)` client methods. |
| `src/packing/PackingView.jsx` | Modify | In `PackingBoxesPane`: fetch box notes alongside shipments; decorate each box with its `note` / `noteUpdatedAt` / `noteUpdatedBy` before passing to `<ShipBoxCard>`. |
| `src/packing/ShipBoxCard.jsx` | Modify | Read `box.note`; render the amber note panel + inline editor; call `api.setBoxNote` on save; read-only when `allShipped`. |

Six files. Four tasks below — schema, server API, client API, UI wiring. Each ends with lint + manual verify + commit.

---

## Task 1: Schema — new `shipment_boxes` table

**Files:**
- Create: `supabase/migrations/0018_shipment_boxes.sql`
- Modify: `supabase/schema.sql` (append a new block after the `shipments` table definition and its RLS line, before the Bridge Jobs section)

The migration must be run against the live Supabase by the operator (the project doesn't auto-apply migrations from CI). Migration is idempotent (`create table if not exists`) so re-runs are safe.

- [ ] **Step 1: Create the migration file**

Write `supabase/migrations/0018_shipment_boxes.sql` with this content:

```sql
-- 0018 · Per-box metadata table.
--
-- A "box" was previously a virtual entity in the codebase: a set of
-- inventory_items sharing a shipmentBoxId. The shipments table holds
-- bought-label rows keyed by that id but its NOT NULL columns are
-- shaped around "a label was purchased" — no good place to hang
-- per-box metadata that exists before (or independent of) a label.
--
-- Elevate the box to its own row. Today it holds the operator's
-- internal seller-note; the table is set up to grow into a home for
-- box-level weight / dims / priority / instructions without
-- contorting shipments.
--
-- Rows are lazy-created the first time the operator saves a note on
-- a box. Missing row = no note. No backfill needed.

create table if not exists shipment_boxes (
  id          text        primary key,            -- = shipmentBoxId on inventory_items
  note        text,                               -- operator's internal note; nullable when cleared
  "updatedAt" timestamptz not null default now(),
  "updatedBy" text
);

alter table shipment_boxes enable row level security;
```

- [ ] **Step 2: Append the same block to `supabase/schema.sql`**

Open `supabase/schema.sql`. Find the line after the `shipments` table block that reads:

```sql
alter table shipments    enable row level security;
```

Immediately after that line and before the next section header (which is the Bridge Jobs comment block starting `-- ─── Bridge Jobs ──...`), insert:

```sql

-- ─── Shipment boxes ──────────────────────────────────────────────────────────
-- Per-box metadata (operator's seller-note today; room for weight/dims/etc.
-- later). Lazy-created the first time a note is saved; missing row = no
-- note. See migration 0018.

create table if not exists shipment_boxes (
  id          text        primary key,            -- = shipmentBoxId on inventory_items
  note        text,
  "updatedAt" timestamptz not null default now(),
  "updatedBy" text
);

alter table shipment_boxes enable row level security;
```

- [ ] **Step 3: Apply the migration against Supabase**

You (the operator) need to apply this manually before the API task lands; otherwise the new endpoints will 500. Two options:

- **Supabase Dashboard:** SQL Editor → paste the contents of `supabase/migrations/0018_shipment_boxes.sql` → Run.
- **Supabase CLI** (if you have it set up): `supabase db push` or equivalent against the linked project.

Verify in the Dashboard's Table Editor that `shipment_boxes` exists with the four columns.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0018_shipment_boxes.sql supabase/schema.sql
git commit -m "$(cat <<'EOF'
supabase: 0018 — shipment_boxes table for per-box metadata

Elevates "box" from a virtual entity (items sharing shipmentBoxId)
to its own row. Today: just the operator's free-text seller-note,
nullable, lazy-created on first save. Future: room for box-level
weight / dims / priority without contorting the shipments table
(whose NOT NULL columns assume a label was purchased).

schema.sql gets the same create-table block appended after the
shipments definition so the snapshot stays canonical.
EOF
)"
```

---

## Task 2: API — `set-box-note` + `box-notes` actions

**Files:**
- Modify: `api/shipments.js` — add two action handlers and route them in the dispatcher

The endpoint already auto-resolves `userId` from the request (line 27) and runs `requireUser(userId)` (line 28) for every action, so the new handlers don't repeat that. The pattern matches `recordTracking(req, res, userId)` which takes `userId` as a third arg for audit stamping.

- [ ] **Step 1: Add the dispatcher entries for both new actions**

In `api/shipments.js`, find the `switch (req.method)` block (around lines 29-46). Update the `GET` and `POST` branches as follows:

```js
  switch (req.method) {
    case 'GET': {
      const action = req.query?.action;
      if (action === 'label-url') return labelUrl(req, res);
      if (action === 'pending') return pending(req, res);
      if (action === 'box-notes') return boxNotes(req, res);
      return list(req, res);
    }
    case 'POST': {
      const action = req.body?.action;
      if (action === 'record-tracking') return recordTracking(req, res, userId);
      if (action === 'clear-tracking') return clearTracking(req, res);
      if (action === 'set-box-note') return setBoxNote(req, res, userId);
      const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
    }
    default:
      return methodNotAllowed(res, ['GET', 'POST']);
  }
```

(Only two lines added — one per branch.)

- [ ] **Step 2: Add the `setBoxNote` handler**

Pick a spot after the existing `recordTracking` / `clearTracking` handlers and before the file's helper functions. Add this function. It uses the existing `supabase` client and the project's standard error-throwing pattern (`const e = new Error(...); e.status = N; throw e;`).

```js
// POST /api/shipments  body: { action: 'set-box-note', shipmentBoxId, note }
// Upserts the per-box note. Empty/whitespace note is persisted as null so
// the row stays as an audit trail of when the note was cleared (and by
// whom). The row is created on first save — `shipment_boxes` is lazy.
async function setBoxNote(req, res, userId) {
  const { shipmentBoxId, note } = req.body || {};
  if (!shipmentBoxId || typeof shipmentBoxId !== 'string') {
    const e = new Error('shipmentBoxId required'); e.status = 400; throw e;
  }
  const trimmed = typeof note === 'string' ? note.trim() : '';
  const payload = {
    id: shipmentBoxId,
    note: trimmed === '' ? null : trimmed,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };
  const { data, error } = await supabase
    .from('shipment_boxes')
    .upsert(payload, { onConflict: 'id' })
    .select('id, note, "updatedAt", "updatedBy"')
    .single();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ box: data });
}
```

- [ ] **Step 3: Add the `boxNotes` handler**

Add this function right after `setBoxNote`. It returns notes for boxes that belong to a given sale (looked up via `inventory_items.shipmentBoxId` for that `saleId`), keyed by `shipmentBoxId` so the client can do `boxNotes[id]` without scanning.

```js
// GET /api/shipments?action=box-notes&saleId=<id>
// Returns { boxNotes: { [shipmentBoxId]: { note, updatedAt, updatedBy } } }
// for boxes that belong to the sale. Boxes with no row are simply absent
// from the map (the client treats absence as "no note").
async function boxNotes(req, res) {
  const saleId = req.query?.saleId;
  if (!saleId) {
    const e = new Error('saleId required'); e.status = 400; throw e;
  }
  // First, collect distinct shipmentBoxIds for this sale. inventory_items
  // is already indexed by saleId — small fan-out, no need to fancy-query.
  const { data: items, error: itemsErr } = await supabase
    .from('inventory_items')
    .select('"shipmentBoxId"')
    .eq('saleId', saleId)
    .not('shipmentBoxId', 'is', null);
  if (itemsErr) { const e = new Error(itemsErr.message); e.status = 500; throw e; }
  const ids = Array.from(new Set((items || []).map(i => i.shipmentBoxId).filter(Boolean)));
  if (ids.length === 0) return res.status(200).json({ boxNotes: {} });
  const { data: rows, error: rowsErr } = await supabase
    .from('shipment_boxes')
    .select('id, note, "updatedAt", "updatedBy"')
    .in('id', ids);
  if (rowsErr) { const e = new Error(rowsErr.message); e.status = 500; throw e; }
  const map = Object.fromEntries((rows || []).map(r => [r.id, {
    note: r.note,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  }]));
  return res.status(200).json({ boxNotes: map });
}
```

- [ ] **Step 4: Lint**

Run: `npm run lint`

Verify with: `npm run lint 2>&1 | grep -E "api/shipments\.js" || echo "(no issues)"`

Expected: `(no issues)`.

- [ ] **Step 5: Smoke-test the endpoints via curl**

The dev server (`npm run dev`) proxies API routes. Pick a real `userId` and an open-box `shipmentBoxId` from the database. Replace `<UID>` and `<BID>` below.

```bash
# Set a note
curl -sS -X POST http://localhost:5173/api/shipments \
  -H 'Content-Type: application/json' \
  -d '{"action":"set-box-note","userId":"<UID>","shipmentBoxId":"<BID>","note":"curl test"}'
# Expected: {"box":{"id":"<BID>","note":"curl test","updatedAt":"...","updatedBy":"<UID>"}}

# Fetch notes for the sale containing this box
curl -sS "http://localhost:5173/api/shipments?action=box-notes&userId=<UID>&saleId=<SALE_ID>"
# Expected: {"boxNotes":{"<BID>":{"note":"curl test","updatedAt":"...","updatedBy":"<UID>"}}}

# Clear it
curl -sS -X POST http://localhost:5173/api/shipments \
  -H 'Content-Type: application/json' \
  -d '{"action":"set-box-note","userId":"<UID>","shipmentBoxId":"<BID>","note":""}'
# Expected: {"box":{"id":"<BID>","note":null,...}}
```

If you don't want to dig up a real `<UID>`/`<BID>` here, skip Step 5 — Task 4's manual checks exercise the same paths via the UI.

- [ ] **Step 6: Commit**

```bash
git add api/shipments.js
git commit -m "$(cat <<'EOF'
shipments api: set-box-note + box-notes actions

set-box-note (POST): upserts shipment_boxes with note (null when
cleared), updatedAt, updatedBy. Lazy-creates the row on first save.

box-notes (GET): for a saleId, returns the notes keyed by
shipmentBoxId for every box that has any items in the sale. Missing
rows are absent from the map (client treats absence as "no note").

Both reuse the dispatcher's existing requireUser auth — no new
auth logic.
EOF
)"
```

---

## Task 3: Client API methods

**Files:**
- Modify: `src/api.js` — two new methods next to the existing shipments group

The `request()` helper auto-appends `userId` to POST bodies and GET query strings for non-auth endpoints (see `src/api.js:9-31`), so the new methods don't pass `userId` manually.

- [ ] **Step 1: Add both methods to the `api` object**

Open `src/api.js`. Find the existing shipments group, which contains `getShipments` (around line 150), `recordPalmstreetTracking` (around 158-159), `clearPalmstreetTracking` (around 161), etc. Add these two methods immediately after `clearPalmstreetTracking`:

```js
  // Per-box notes (lazy `shipment_boxes` rows). Internal operator
  // memos shown only in the ShipBoxCard drill-down.
  getBoxNotes: (saleId) =>
    request(`/shipments?action=box-notes&saleId=${encodeURIComponent(saleId)}`).then(r => r.boxNotes || {}),
  setBoxNote: ({ shipmentBoxId, note }) =>
    request('/shipments', { method: 'POST', body: { action: 'set-box-note', shipmentBoxId, note } }).then(r => r.box),
```

- [ ] **Step 2: Lint**

Run: `npm run lint`

Verify with: `npm run lint 2>&1 | grep -E "src/api\.js" || echo "(no issues)"`

Expected: `(no issues)`.

- [ ] **Step 3: Commit**

```bash
git add src/api.js
git commit -m "$(cat <<'EOF'
api client: getBoxNotes(saleId) + setBoxNote({ shipmentBoxId, note })

Thin wrappers around the two new /api/shipments actions. userId is
auto-attached by the request() helper; methods return the unwrapped
data (boxNotes map and box row).
EOF
)"
```

---

## Task 4: UI — PackingBoxesPane wiring + ShipBoxCard note panel

**Files:**
- Modify: `src/packing/PackingView.jsx` — `PackingBoxesPane` fetches box notes and decorates each box object
- Modify: `src/packing/ShipBoxCard.jsx` — accept box notes via the existing `box` prop; render the note panel + inline editor

This is the larger task. It does the data fetch, the prop decoration, the new UI section, and the save call. Verifying everything in one browser session at the end.

- [ ] **Step 1: `PackingBoxesPane` — add `boxNotesByBox` state and fetch in parallel with shipments**

In `src/packing/PackingView.jsx`, find `PackingBoxesPane` (around line 1669). Its existing state declarations include `shipmentsByBox`. Add a sibling state and update the existing fetch effects.

Find the `useState({})` for `shipmentsByBox` and add right below it:

```jsx
  const [boxNotesByBox, setBoxNotesByBox] = useState({});
```

Then find the first `useEffect` in this function (the mount-time fetch) and the `refreshShipments` callback (the post-mutation refetch). Both currently call `api.getShipments()` only. Update each to also fetch notes in parallel. The mount-time effect becomes:

```jsx
  useEffect(() => {
    (async () => {
      try {
        const [list, notes] = await Promise.all([
          api.getShipments(),
          api.getBoxNotes(sale.id),
        ]);
        setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
        setBoxNotesByBox(notes || {});
      } catch {
        // Silent — shipments / notes simply won't show until refresh.
      }
    })();
  }, [sale.id]);
```

And `refreshShipments` (the callback used after Buy/Void) becomes:

```jsx
  const refreshShipments = async () => {
    try {
      const [list, notes] = await Promise.all([
        api.getShipments(),
        api.getBoxNotes(sale.id),
      ]);
      setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
      setBoxNotesByBox(notes || {});
    } catch {
      // Silent.
    }
  };
```

- [ ] **Step 2: `PackingBoxesPane` — decorate each box with its note before passing to `<ShipBoxCard>` and wire the save callback**

In the same `PackingBoxesPane`, find the `<ShipBoxCard` mount (currently around line 1797 after the prior commits this session). Add two props: a decorated `box` prop that includes the note fields, and a new `onSaveNote` callback. The mount becomes:

```jsx
          <ShipBoxCard
            key={box.id}
            box={{ ...box, ...(boxNotesByBox[box.id] || {}) }}
            shipment={shipmentsByBox[box.id]}
            showToast={showToast}
            onPrintItemLabels={onPrintItemLabels}
            onSaveNote={async (note) => {
              const saved = await api.setBoxNote({ shipmentBoxId: box.id, note });
              setBoxNotesByBox(prev => ({
                ...prev,
                [box.id]: {
                  note: saved.note,
                  updatedAt: saved.updatedAt,
                  updatedBy: saved.updatedBy,
                },
              }));
            }}
            onShip={() => onShipBox(box.items.map(i => i.id))}
            onBuyLabel={() => setBuyingFor(box)}
```

(The closing of the `<ShipBoxCard ...>` element is unchanged. The two changes are: spreading the note into `box=`, and adding `onSaveNote`.)

- [ ] **Step 3: `ShipBoxCard` — accept the new prop**

In `src/packing/ShipBoxCard.jsx`, find the function signature (around line 46 after prior commits this session). It currently destructures `box, shipment, showToast, onShip, onBuyLabel, onVoidLabel, onSaveTracking, onClearTracking, onPrintItemLabels,`. Add `onSaveNote` to that list:

```jsx
export function ShipBoxCard({
  box, shipment, showToast,
  onShip,
  onBuyLabel, onVoidLabel,
  onSaveTracking, onClearTracking,
  onPrintItemLabels,
  onSaveNote,
}) {
```

- [ ] **Step 4: `ShipBoxCard` — add note state + import StickyNote / Pencil icons**

Near the existing `useState` declarations at the top of `ShipBoxCard` (around lines 52-56), add the editor state:

```jsx
  const [editingNote, setEditingNote] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteErr, setNoteErr] = useState('');
```

And in the `lucide-react` import line at the top of the file, add `StickyNote` and `Pencil`:

```jsx
import {
  ChevronDown, ChevronRight, Truck, ShoppingCart, PackageCheck,
  MapPin, Box, Send, RotateCcw, Download as DownloadIcon, Edit2, Tag, Printer,
  StickyNote, Pencil,
} from 'lucide-react';
```

- [ ] **Step 5: `ShipBoxCard` — render the note panel between the item list and the tracking editor**

Find the closing of the `box.items.map(...)` block — the `))}` and the closing `</div>` of the items container, immediately followed by the comment `{/* Inline USPS tracking editor — opens via "Add tracking" or "Edit". */}`. Insert the new note section between them. The full new block:

```jsx
          {/* Operator's internal seller-note. Single text field per box,
              edit overwrites, never printed. Lazy-persisted to
              shipment_boxes via api.setBoxNote. Hidden in edit form when
              the box is already shipped. */}
          {onSaveNote && (() => {
            const hasNote = !!(box.note && box.note.trim());
            const beginEdit = () => {
              setNoteInput(box.note || '');
              setNoteErr('');
              setEditingNote(true);
            };
            if (editingNote) {
              return (
                <div className="px-4 py-3 bg-amber-50 border-t border-amber-100 space-y-2">
                  <div className="text-[11px] uppercase tracking-wide text-amber-800 font-medium">Note</div>
                  <textarea
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    rows={2}
                    autoFocus
                    placeholder="Operator note for this box (internal — not printed)"
                    className="w-full px-3 py-2 text-sm border border-amber-300 rounded-lg resize-y bg-white"
                  />
                  {noteErr && <div className="text-sm text-red-600">{noteErr}</div>}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => { setEditingNote(false); setNoteErr(''); }}
                      disabled={savingNote}
                      className="px-3 py-1.5 text-sm rounded-lg hover:bg-amber-100"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        setSavingNote(true);
                        setNoteErr('');
                        try {
                          await onSaveNote(noteInput);
                          setEditingNote(false);
                          showToast?.('Note saved', 1800);
                        } catch (e) {
                          setNoteErr(e.message || 'Save failed');
                        } finally {
                          setSavingNote(false);
                        }
                      }}
                      disabled={savingNote}
                      className="px-3 py-1.5 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg disabled:opacity-60"
                    >
                      Save
                    </button>
                  </div>
                </div>
              );
            }
            if (hasNote) {
              return (
                <div className="px-4 py-2.5 bg-amber-50 border-t border-amber-100 flex items-start gap-2">
                  <StickyNote className="w-3.5 h-3.5 text-amber-700 mt-0.5" />
                  <div className="flex-1 min-w-0 text-sm text-amber-900 whitespace-pre-wrap break-words">{box.note}</div>
                  {!allShipped && (
                    <button
                      type="button"
                      onClick={beginEdit}
                      title="Edit note"
                      className="p-1 text-amber-700 hover:bg-amber-100 rounded"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            }
            if (allShipped) return null;  // no "Add note" CTA on already-shipped boxes
            return (
              <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                <button
                  type="button"
                  onClick={beginEdit}
                  className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-amber-700"
                >
                  <StickyNote className="w-3.5 h-3.5" /> Add note
                </button>
              </div>
            );
          })()}
```

- [ ] **Step 6: Lint**

Run: `npm run lint`

Verify with: `npm run lint 2>&1 | grep -E "packing/(PackingView|ShipBoxCard)\.jsx" || echo "(no issues)"`

Expected: `(no issues)`.

- [ ] **Step 7: Manual browser verification**

Migration must already be applied (Task 1, Step 3). With `npm run dev` running:

1. Open Shipping → click into a buyer with at least one open box. The `PackingBoxesPane` loads.
2. On a box card with no note, confirm the small **`📝 Add note`** button appears below the item list (above the action-button row).
3. Click it → an amber-tinted textarea appears with **Save** / **Cancel** buttons.
4. Type `test note from shift A`. Click **Save** → panel transitions to the read-only amber note row showing the text + a pencil icon. Toast: "Note saved".
5. Hard-reload the page → drill back into the same buyer → confirm the note persists.
6. Click the pencil icon → textarea pre-fills with the current note. Edit to `updated text`. Save → panel updates without page reload.
7. Click the pencil → clear the textarea entirely → Save → panel collapses back to **`📝 Add note`**.
8. Mark the box shipped (existing **Mark Shipped** button). Reload → drill back in → if the box has a note, it should render read-only (no pencil). The **`📝 Add note`** button should NOT appear on shipped boxes.
9. (Optional) Open a brand-new box with no `shipments` row (no label purchased yet) — confirm **`📝 Add note`** works the same.
10. Cancel button while editing → reverts without saving.
11. Force an error path: temporarily block the network in DevTools, hit Save → confirm inline red error appears and Save button re-enables.

- [ ] **Step 8: Commit**

```bash
git add src/packing/PackingView.jsx src/packing/ShipBoxCard.jsx
git commit -m "$(cat <<'EOF'
shipping: operator's seller-note on the open box

ShipBoxCard renders an inline amber note panel between the item
list and the tracking/action area. Empty box → "+ Add note" CTA;
note present → read-only row + pencil to edit; editing → textarea
+ Save/Cancel. Read-only when allShipped.

PackingBoxesPane fetches notes in parallel with shipments via the
new api.getBoxNotes(saleId), decorates each box object with
{ note, updatedAt, updatedBy } from the map, and wires an
onSaveNote callback that calls api.setBoxNote and updates the
local map without a full refetch.
EOF
)"
```

---

## Self-review notes

**Spec coverage:**
- New `shipment_boxes` table, lazy-created → Task 1 (migration + schema.sql). ✓
- `set-box-note` POST action → Task 2 Step 2. ✓
- Note fetched + merged on drill-down — design moved from "extend getShipments" to "new `box-notes` GET action" for cleaner separation (top-level Ready tab doesn't need to fetch notes; only the drill-down does). Spec change documented in Task 2's handler doc-comment. ✓
- Client methods `setBoxNote` + (new) `getBoxNotes` → Task 3. ✓
- UI: inline panel between items and actions; empty state CTA; amber styling matching ItemNotes seller color → Task 4 Step 5. ✓
- Read-only when `allShipped` → Task 4 Step 5 (hides Pencil + the "+ Add note" CTA; renders the note row read-only when one exists). ✓
- Edit overwrites; empty save clears to null but row stays for audit → Task 2 Step 2 handler (`note: trimmed === '' ? null : trimmed`). ✓
- No labels affected → no labels/* files in the file map. ✓

**Type / name consistency:**
- `shipmentBoxId` (camelCase) used consistently in API body, client methods, and `box.id` mapping. ✓
- `onSaveNote(note: string) => Promise<void>` callback shape used identically in PackingBoxesPane wiring (Step 2) and ShipBoxCard onClick handler (Step 5). ✓
- `box.note`, `box.updatedAt`, `box.updatedBy` flow: server returns these fields on `shipment_boxes` rows → `getBoxNotes` returns them → PackingBoxesPane spreads them onto each `box` object → ShipBoxCard reads `box.note`. Consistent. ✓
- `boxNotesByBox` (component state) and `boxNotes` (API response) are different names but related; spec-aligned. The Pane shape is `{ [id]: { note, updatedAt, updatedBy } }` end-to-end. ✓
- `StickyNote` and `Pencil` from `lucide-react` — both real exports in lucide-react v1.8+ (this repo's version per package.json). ✓

**Placeholder scan:** No TBDs, no "implement later", every code-changing step shows the exact code or precise insertion instructions referenced against current line numbers. ✓
