# Purchase tab rewrite — design

**Date:** 2026-05-18
**Status:** approved, ready for implementation plan

## Motivation

The current Purchase tab is a single in-progress cart, persisted only to `localStorage` under one anonymous key. There is no concept of an "event," no way to keep multiple drafts in flight, no shared state between devices, and no historical record after the CSV is exported. The operator can build at most one PO at a time, and a browser-storage wipe erases it.

This rewrite turns each purchase order into a named, persisted event with auto-save, modeled after the existing Sales pattern.

## Goals

- Create a purchase event with a name, date, and supplier before picking items.
- Pick cultivars into the event using the existing rich catalog (sales-history-aware stats, filters, sort).
- Auto-save edits to the database so a half-built order survives a refresh, a closed tab, or a different device.
- List existing purchase orders on tab entry; filter by Draft vs Exported.
- Preserve the existing CSV export as the finish line.

## Non-goals (deferred)

The following are intentionally out of scope. The schema and UI shape leave room to add each later without rework.

- Status states beyond Exported (no Ordered / Received).
- Per-line cost override (operator typing in the vendor's quoted price).
- Per-line notes.
- Auto-creating `inventory_items` rows when a PO is "received."
- A managed `suppliers` table — supplier is free-text with autocomplete from prior values.
- Multi-user collaboration / row locking.
- Sharing a PO via link.

## Data model

Two new tables, named to match the existing schema's camelCase-quoted convention.

### `purchase_orders`

| column | type | notes |
|---|---|---|
| `id` | `text` PK | client-generated (matches `newId()` pattern used elsewhere) |
| `name` | `text not null` | operator-typed, e.g. "Spring 2026 Aroid Restock" |
| `supplier` | `text not null default ''` | free-text; empty allowed |
| `"orderDate"` | `date` nullable | the date associated with this PO; defaults to today on create |
| `"createdAt"` | `timestamptz not null default now()` | |
| `"createdBy"` | `text` | `users.displayName` of the creator |
| `"exportedAt"` | `timestamptz` nullable | null = Draft, non-null = Exported (re-exports update this) |
| `"deletedAt"` | `timestamptz` nullable | soft-delete; list view filters these out by default |

Indexes:
- `purchase_orders_created_at_idx on ("createdAt" desc)` — list view sort.

### `purchase_order_lines`

| column | type | notes |
|---|---|---|
| `id` | `text` PK | client-generated |
| `"purchaseOrderId"` | `text not null` → `purchase_orders(id)` on delete cascade | parent |
| `variety` | `text not null default ''` | matches the cultivar key |
| `name` | `text not null` | cultivar name |
| `qty` | `integer not null check (qty > 0)` | qty=0 is represented by row absence |
| `"snapshotAvgCost"` | `numeric(10,2)` nullable | the avg cost at the time the line was added; used in CSV export for stability |
| `"createdAt"` | `timestamptz not null default now()` | |

Constraints / indexes:
- `unique ("purchaseOrderId", variety, name)` — one row per cultivar per PO. This is what makes per-line auto-save upserts work.
- `purchase_order_lines_po_idx on ("purchaseOrderId")` — fast load of a PO's lines.

RLS enabled on both tables as defense-in-depth, matching the rest of the schema.

### Migration

Single migration `supabase/migrations/0014_purchase_orders.sql` adds both tables, indexes, RLS, and the matching `schema.sql` updates.

## API

New file `api/purchase-orders.js`. Dispatcher matching the `auth.js` / `bridge.js` pattern.

| action | method | body / query | auth | returns |
|---|---|---|---|---|
| `list` | GET | `?userId=...` | `requireUser` | `{ purchaseOrders: [...] }` (active only; no lines) |
| `get` | GET | `?action=get&id=...&userId=...` | `requireUser` | `{ purchaseOrder, lines: [...] }` |
| `create` | POST | `{ userId, name, supplier, orderDate }` | `requireUser` | `{ purchaseOrder }` (no lines yet) |
| `update` | POST | `{ userId, id, name?, supplier?, orderDate?, exportedAt? }` | `requireUser` | `{ purchaseOrder }` |
| `upsertLine` | POST | `{ userId, id, variety, name, qty, snapshotAvgCost? }` | `requireUser` | `{ line }` |
| `removeLine` | POST | `{ userId, id, variety, name }` | `requireUser` | `{ ok: true }` |
| `delete` (soft) | POST | `{ userId, id }` | `requireUser` | `{ ok: true }` |

All actions use `requireUser` — no admin gate. Purchasing is operational like Sales.

Server-owned fields stripped from inputs: `id` (for `create`), `createdAt`, `createdBy`, `deletedAt` (managed by server).

## UI

One component file replaces the current one: `src/purchasing/PurchaseOrderView.jsx`. Two internal views; the existing entry component keeps its export so `App.jsx`'s lazy import doesn't need to change.

### Component structure

```
PurchaseOrderView (entry)
├── if !activePoId: <POList />
└── if  activePoId: <POPicker poId={activePoId} />
```

State for `activePoId` is local to `PurchaseOrderView`; selecting a row sets it, "Back to list" clears it.

### POList — tab landing

- Header row: title + "+ New purchase order" button (top-right).
- Filter pills: All / Draft / Exported (purely client-side, against the loaded list).
- Row per PO, sorted by `createdAt desc`:
  - Name (large) · supplier (or em-dash if blank) · order date
  - "N lines · created Mar 12" footer
  - Pill on the right: "Draft" or "Exported"
  - "..." menu: rename (opens a small inline editor), delete (confirm dialog → soft-delete).
- Tap row → sets `activePoId` → switches to picker.
- Empty state: "No purchase orders yet. Tap + New purchase order to start one."

### POPicker — when a PO is open

- Sticky header bar:
  - Left: "← Back" (clears `activePoId`).
  - Middle: name (inline-editable), supplier (`<input list="po-suppliers">` with a datalist populated from distinct prior supplier values), order date.
  - Right: save-status pill (Saved / Saving... / Failed · Retry) + "Export CSV" button.
- Body: reuses the existing cultivar grid, including `buildCultivarStats`, the sort dropdown, variety tabs, search field, and "With sales history only" toggle. The grid cells, qty +/− controls, and per-card stats stay as they are.
- Bottom summary card: stays where it is, shows totals (units, est. cost, est. revenue, est. profit). The Clear and Export buttons relocate here. "Clear" wipes lines from the active PO (not from the entire system); confirm dialog.

### + New modal

Three fields:
- Name (required, text, autofocus)
- Supplier (optional, text with datalist autocomplete)
- Order date (date input, defaults to today)

"Create" → POST `create` → response includes the new PO id → set `activePoId` → close modal → POPicker mounts with empty lines.

## Auto-save

State inside POPicker:

```js
{
  po: { ...purchaseOrder },
  lines: Map<key, { id, variety, name, qty, snapshotAvgCost }>,  // key = `${variety}|${name}`
  dirtyKeys: Set<key>,
  saveStatus: 'idle' | 'saving' | 'error',
}
```

### Flow per qty change

1. Optimistic local update of `lines` for the affected key.
2. Add key to `dirtyKeys`.
3. Debounce 500ms after the last edit. (Single shared timer; resets on each edit.)
4. On fire: snapshot the dirty set, clear it, set `saveStatus = 'saving'`, then `Promise.all` the per-key requests:
   - If `qty > 0`: POST `upsertLine` with the current local state.
   - If `qty == 0` or key absent: POST `removeLine`.
5. On all-success: `saveStatus = 'idle'`.
6. On any failure: `saveStatus = 'error'`. Re-add the failed keys to `dirtyKeys` so the next edit (or a manual retry click on the pill) re-queues them.

### snapshotAvgCost

Computed from `buildCultivarStats(items)` at the moment the line is first added. Sticky after that — re-editing qty doesn't refresh the snapshot. This keeps the exported CSV stable: a PO created two weeks ago doesn't silently drift when sales history changes.

### Switching between POs

If `activePoId` changes while `dirtyKeys` is non-empty, flush them first (await the in-flight save), then load the new PO. Prevents losing edits to PO A by tapping into PO B too fast.

### Network failure recovery

Optimistic UI persists across the failure. The pill shows "Failed · Retry"; tapping it re-runs the dirty-flush. If the operator closes the tab with `saveStatus === 'error'`, the local-only edits are lost — but the prior successful save state is intact on the server, which is the recovery floor.

## CSV export

Same columns as today's export (variety, cultivar, qty, avg cost, line cost, avg sold price, expected revenue, avg profit, expected profit, profit rate %, currently available, total sold). Sourced from the loaded PO + lines instead of in-memory cart state.

Clicking Export:
1. Generate the CSV in-browser (no server roundtrip needed).
2. Trigger download.
3. POST `update` with `{ id, exportedAt: nowIso }`.
4. UI moves the PO from Draft to Exported in the filter pills.

Export remains non-terminal. Re-clicking exports again and updates `exportedAt` to the new timestamp.

## Migration / rollout

- The `localStorage` draft key `purchase-order-draft-v1` is no longer read by any code path. One-time forfeit — if the operator had an in-flight cart in the old UI, they recreate it as a named PO in the new one.
- The localStorage key itself is left in place; we don't bother deleting it.
- No user-facing migration toast. The new UI is self-explanatory; a toast referencing the legacy draft would only confuse anyone who didn't have one.

## Error handling

- API: every handler wraps in `wrap()`, returns `{ error }` with appropriate status on failure. Mirrors the existing endpoints.
- UI: each fetch goes through `src/api.js` (extend `api` object with `purchaseOrders.*` methods). Errors propagate to the save-status pill (in picker) or a toast (in list / new-modal).
- Validation:
  - `name` required, max 200 chars (matches other text fields).
  - `qty` must be a positive integer; non-positive sends `removeLine` instead.
  - `supplier` no validation beyond text.

## Testing

No automated test framework in this repo (per the existing pattern). Manual smoke test plan:

1. Create a PO — appears in list, status Draft.
2. Open it, pick 3 cultivars, refresh the browser, all 3 still there.
3. Tap a 4th, immediately tap Back before save fires → returns to list with all 4 persisted.
4. Export CSV → row moves to Exported pill, CSV downloads with correct data.
5. Re-open same PO, change a qty → status returns to "Saving" then "Saved"; exportedAt updates on next export.
6. Soft-delete a PO → disappears from list. (No undo in v1.)
7. Open with network unplugged → save fails, pill shows "Failed · Retry". Reconnect, tap Retry → recovers.
8. Two POs in flight, switch between them rapidly while editing — no edits lost, no cross-contamination.

## Open questions

None. All open decisions have been resolved in conversation:

- Q1: PO fields = name + date + supplier.
- Q2: Lifecycle = Draft → Exported (CSV is the finish line). No Ordered / Received states in v1.
- Q3: Tab entry = list of POs.
- Q4: Save model = auto-save with debounce.
- Q5: Architecture = normalized tables (Approach A).
