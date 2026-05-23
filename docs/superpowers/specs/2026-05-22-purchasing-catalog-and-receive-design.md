# Purchasing rewrite — catalog, POs, receive-to-inventory

**Date:** 2026-05-22
**Status:** approved, ready for implementation plan
**Supersedes:** [2026-05-18-purchase-tab-rewrite-design.md](2026-05-18-purchase-tab-rewrite-design.md) (never implemented — no `0014_purchase_orders.sql` migration, no `api/purchase-orders.js`)

## Motivation

The current Purchase tab is a read-only cultivar-stats CSV exporter. It derives "what to reorder" from existing inventory rollups, then dumps to CSV — no persisted POs, no supplier, no receive flow, no SKU creation.

The May-18 spec turned the cart into named persisted POs but explicitly deferred catalog photos/prices, supplier auto-prefill, the Ordered/Received lifecycle, and SKU auto-creation on receive. Today's redesign delivers all of those as the initial implementation, skipping the deferred-features v1 entirely.

## Goals

- A browseable **plant catalog** — photos, wholesale price, ideal selling price — built on the existing `species` table (no parallel taxonomy).
- Build a **purchase order** from the catalog, with a free-text supplier and a shipping fee on the header.
- Track POs through **draft → ordered → received**, with partial receipts at the line level.
- On receive, **auto-create `inventory_items`** rows (one SKU per unit) with `grossCost = unitWholesalePrice + perUnitShipping`.
- Walk back from any received SKU to its originating PO line (audit table).

## Non-goals (deferred)

- Managed `suppliers` table — supplier is free-text on PO header.
- Per-supplier wholesale prices per plant.
- Manual SKU edits at receive time (you receive at the line's snapshot price; if it's wrong, cancel-receive and re-receive after fixing the line).
- Receiving a single unit at a time (per-line bulk receive only; partial receipts handle the "some arrived" case).
- Catalog import / bulk price upload (operators edit catalog cards inline).
- Photo cropping / image transforms — uploads land in storage as-is.

## Data model

All column names use double-quoted camelCase per the existing schema convention.

### `species` — add three columns

```sql
alter table species add column if not exists "wholesalePrice" numeric;
alter table species add column if not exists "idealSellingPrice" numeric;
alter table species add column if not exists "primaryPhotoId" text;
```

`primaryPhotoId` is a soft reference (no FK constraint) into `species_photos.id`. Null = "first uploaded photo by sortOrder wins". This avoids a circular FK and lets us delete photos without unwinding species rows.

### `species_photos` — new

| column | type | notes |
|---|---|---|
| `id` | `text` PK | client-generated |
| `"speciesId"` | `text not null` → `species(id)` on delete cascade | parent |
| `"storagePath"` | `text not null` | path within the `plant-photos` Supabase Storage bucket; API generates signed URLs at read time |
| `"sortOrder"` | `integer not null default 0` | display order in the gallery |
| `"createdAt"` | `timestamptz not null default now()` | |
| `"createdBy"` | `text` | |

Indexes: `species_photos_species_idx on ("speciesId", "sortOrder")`.

The existing `species.imageUrl` stays for backward compat. On the first `POST /api/species-photos` for a species that still has a non-null `imageUrl`, the upload handler also moves that URL into a `species_photos` row (sortOrder = 0) and clears `species.imageUrl` in the same transaction. Reads in the catalog UI prefer `species_photos`; if empty, fall back to `imageUrl`. This means once an operator uploads even one real photo, the legacy `imageUrl` migrates itself out.

### `purchase_orders` — new

| column | type | notes |
|---|---|---|
| `id` | `text` PK | client-generated |
| `supplier` | `text not null default ''` | free-text; empty allowed |
| `status` | `text not null default 'draft' check (status in ('draft','ordered','received'))` | |
| `"orderedAt"` | `timestamptz` nullable | set when status flips to ordered |
| `"receivedAt"` | `timestamptz` nullable | set when every line is fully received |
| `"shippingFee"` | `numeric not null default 0` | |
| `notes` | `text` | |
| `"createdAt"` | `timestamptz not null default now()` | |
| `"createdBy"` | `text` | |
| `"modifiedAt"` | `timestamptz` | |
| `"modifiedBy"` | `text` | |
| `"deletedAt"` | `timestamptz` nullable | soft-delete |

Indexes: `purchase_orders_status_created_idx on (status, "createdAt" desc)`.

### `purchase_order_lines` — new

| column | type | notes |
|---|---|---|
| `id` | `text` PK | client-generated |
| `"purchaseOrderId"` | `text not null` → `purchase_orders(id)` on delete cascade | parent |
| `"speciesId"` | `text not null` → `species(id)` on delete restrict | what plant |
| `"quantityOrdered"` | `integer not null check ("quantityOrdered" > 0)` | |
| `"quantityReceived"` | `integer not null default 0 check ("quantityReceived" >= 0)` | |
| `"unitWholesalePrice"` | `numeric not null` | snapshot from species at line-add time; editable while draft |
| `"sortOrder"` | `integer not null default 0` | display order |

Constraints:
- `unique ("purchaseOrderId", "speciesId")` — one line per species per PO. "Add to draft" on a plant already in the draft increments `quantityOrdered` instead of inserting a duplicate.

Indexes: `purchase_order_lines_po_idx on ("purchaseOrderId", "sortOrder")`.

### `purchase_order_received_items` — new (audit link)

| column | type | notes |
|---|---|---|
| `id` | `text` PK | client-generated |
| `"lineId"` | `text not null` → `purchase_order_lines(id)` on delete cascade | |
| `"inventoryItemId"` | `text not null` → `inventory_items(id)` on delete cascade | one row per generated SKU |
| `"receivedAt"` | `timestamptz not null default now()` | |
| `"receivedBy"` | `text` | |

Unique: `unique ("inventoryItemId")` — a generated SKU can only belong to one PO line.

Indexes: `purchase_order_received_items_line_idx on ("lineId")`.

### RLS

All new tables: `enable row level security` with no policies (defense-in-depth, matches the rest of the schema). Server-side API uses the service role.

### Migration

Single migration `supabase/migrations/0015_purchasing_redesign.sql` containing all of the above. Mirror the schema changes in `supabase/schema.sql` for fresh-DB consistency.

### Backfill

None required at migration time. Existing `species` rows arrive with `wholesalePrice`, `idealSellingPrice`, and `primaryPhotoId` null. Existing `species.imageUrl` rows stay as-is and the catalog UI shows them via the fallback path until the operator uploads a real photo.

## API

New file `api/purchase-orders.js`, action-dispatched in the style of `api/bridge.js`:

| action | method | body / query | auth | returns |
|---|---|---|---|---|
| `list` | GET | `?status=draft,ordered,received` (CSV; defaults to draft,ordered) | `requireUser` | `{ purchaseOrders: [...] }` (with line counts but no line bodies) |
| `get` | GET | `?action=get&id=...` | `requireUser` | `{ purchaseOrder, lines, receivedItems }` |
| `create` | POST | `{ supplier?, shippingFee?, notes? }` | `requireUser` | `{ purchaseOrder }` |
| `update-header` | POST | `{ id, supplier?, shippingFee?, notes? }` | `requireUser` | `{ purchaseOrder }` (only when status in draft/ordered) |
| `add-line` | POST | `{ id, speciesId, quantityOrdered, unitWholesalePrice? }` | `requireUser` | `{ line }` (only when status = draft; if `unitWholesalePrice` omitted, snapshots from species; if line exists, increments `quantityOrdered`) |
| `update-line` | POST | `{ id, lineId, quantityOrdered?, unitWholesalePrice? }` | `requireUser` | `{ line }` (only when status = draft; passing `quantityOrdered = 0` is rejected — use `remove-line` instead) |
| `remove-line` | POST | `{ id, lineId }` | `requireUser` | `{ ok: true }` (only when status = draft) |
| `mark-ordered` | POST | `{ id }` | `requireUser` | `{ purchaseOrder }` (sets `orderedAt`, flips to ordered) |
| `receive-line` | POST | `{ id, lineId, quantityReceived }` | `requireUser` | `{ line, createdInventoryItemIds }` (see "Receive transaction") |
| `cancel-receive-line` | POST | `{ id, lineId }` | `requireUser` | `{ line, deletedCount }` (soft-deletes still-`available` SKUs from this line, decrements `quantityReceived`) |
| `delete` | POST | `{ id }` | `requireUser` | `{ ok: true }` (soft-delete; only when status = draft) |

Extensions to `api/species.js`:

- `POST` and `PATCH` accept the new `wholesalePrice`, `idealSellingPrice`, `primaryPhotoId` fields.
- `GET` returns each species with a `photos: [{id, url, sortOrder}]` array (joined from `species_photos`).

New file `api/species-photos.js` (or merged into `api/species.js` as additional actions):

| action | method | purpose |
|---|---|---|
| `upload` | POST (base64 in JSON body, matching existing label upload pattern in `api/shipments.js`) | uploads to `plant-photos` Supabase Storage bucket, inserts a `species_photos` row (and migrates the legacy `species.imageUrl` if present), returns `{ photo, signedUrl }` |
| `delete` | POST | removes the storage object + row; if it was the species's `primaryPhotoId`, clears that field |
| `reorder` | POST | `{ speciesId, orderedPhotoIds: [...] }` — sets `sortOrder` per the array |

A new Supabase Storage bucket `plant-photos` is created (parallel to the existing `shipping-labels` bucket). Public read; writes via service role only.

All actions use `requireUser`. No admin gate — purchasing is operational.

## UI

One new top-level tab "Purchase" (replacing the existing one). Component file `src/purchasing/PurchasingView.jsx` replaces `PurchaseOrderView.jsx`. Two sub-tabs:

```
PurchasingView
├── sub-tab: Catalog  → <CatalogPane />
└── sub-tab: Orders   → <OrdersPane />
```

The lazy import in `App.jsx` updates to point at the new file.

### Catalog sub-tab — `<CatalogPane />`

**Top bar**
- Variety filter tabs (All + each variety, count per tab), matching the existing pattern in `PackingView`.
- Search (cultivar / variety / common name).
- Sort dropdown: Name (default), Wholesale price, Ideal price, Margin %, Recently added.
- "+ New plant" button on the right — opens the plant detail modal pre-attached to a chosen variety.

**Plant grid** — 2 cols mobile / 3 tablet / 4 desktop. Each card:

```
┌────────────────────────┐
│   [primary photo]      │  ← tap → photo gallery modal
├────────────────────────┤
│ ALOCASIA               │  ← variety, small caps
│ sinuata 'Aurea'        │  ← name
│ ───────────────────    │
│ Wholesale  $12.00 ✎    │  ← inline-edit on click
│ Ideal      $45.00 ✎    │
│ Margin     ~73%        │  ← computed: (ideal-wholesale)/wholesale
│ ───────────────────    │
│ [+ Add to draft]       │
└────────────────────────┘
```

- Cards without `wholesalePrice` show "Set wholesale" prompt where the value would be (still browseable).
- Cards without any photo show a placeholder svg.

**Plant detail modal** (tap anywhere except "+ Add to draft"):

- Photo gallery: upload, reorder via drag, set primary, delete.
- Variety / species fields (reuse existing `SpeciesPicker.jsx`).
- `wholesalePrice`, `idealSellingPrice`, `commonName`, `notes`, `profitRate` (existing).
- "Save" persists via the existing `PATCH /api/species` plus photo CRUD.

**Sticky draft mini-bar** (bottom of the screen, both mobile and desktop, visible whenever a draft PO exists):

```
   3 plants in draft · 15 units · est. $180   [Open draft →]
```

Tapping switches to Orders sub-tab and expands that draft inline. State key for "current draft" is the most-recently-edited PO whose `status === 'draft'` (server-derived; no localStorage).

**"+ Add to draft"** behavior:
- No active draft: creates a new draft PO, then adds the line.
- Active draft, plant not in it: adds a new line at the catalog's `wholesalePrice`.
- Active draft, plant already in it: increments `quantityOrdered` (relies on the `unique ("purchaseOrderId", "speciesId")` constraint server-side).

### Orders sub-tab — `<OrdersPane />`

**List view**

Three filter pills: Draft · Ordered · Received. Default = Draft + Ordered.

Each PO row:

```
┌─────────────────────────────────────────────────────┐
│ ●draft   2026-05-22                Bob's Nursery    │
│ 4 lines · 22 units · $264 + $40 ship                │
│                                       [Open →]      │
└─────────────────────────────────────────────────────┘
```

Status dot: gray=draft, amber=ordered, emerald=received. Tap row → inline-expand (same pattern as `PackingView` box cards).

**Expanded PO detail**

Header row: supplier (editable while draft/ordered, autocomplete from distinct prior values), shipping fee (editable while draft/ordered), notes textarea, status pill.

Action buttons by status:
- `draft` → `[Mark ordered]` · `[Delete PO]`
- `ordered` → `[Mark all received]` (convenience for "everything arrived as expected" — calls receive-line on every line with their full remaining qty)
- `received` → read-only

**Line row** — one per `purchase_order_lines` entry:

```
┌────────────────────────────────────────────────────────────────┐
│ [small photo]  Alocasia · sinuata 'Aurea'                      │
│                Ordered: 10  @  $12.00  =  $120.00              │
│                Received: [    ]/10        [Receive]            │
└────────────────────────────────────────────────────────────────┘
```

Line state by PO status:
- `draft`: `quantityOrdered` editable (number input), `unitWholesalePrice` editable (currency input), `Remove line` button visible.
- `ordered`: `quantityReceived` input shown (default = remaining); `Receive` button enabled when input > 0. Line price/qty locked.
- `received`: all locked. A small `View N SKUs ▾` link expands to show the generated `inventory_items.sku` list (from `purchase_order_received_items`).

### "+ New plant" modal

Reuse the catalog plant detail modal in create mode. No separate flow.

## Receive transaction

The `receive-line` action runs as a single Postgres transaction (server-side):

1. **Read** the line's `quantityOrdered`, `quantityReceived`, `unitWholesalePrice`, parent PO's `shippingFee`, and `sum(quantityOrdered)` across all the PO's lines.
2. **Allocate per-unit shipping**: `perUnitShipping = round(shippingFee / sumOrdered, 4)`. Locked at receive time per line, so partial receipts on the same line all use the same rate. (Lines on the same PO will all see the same rate as long as nobody adds new lines between receives — and lines can't be added once status is ordered.)
3. **For each unit being received** in this call (`n = quantityReceived` from the request):
   - Generate next SKU via existing `inventory_max_sku_suffix()` RPC + the species's variety code.
   - Insert `inventory_items` row:
     - `speciesId` (denormalized `name` + `variety` from the species record)
     - `grossCost = unitWholesalePrice + perUnitShipping`
     - `idealPrice = species.idealSellingPrice` (nullable — leaves the existing pricing logic to fill in via `profitRate` fallback if not set)
     - `status = 'available'`, `quantity = 1`, `type = 'plant'`, `lotKind = 'sale'`
     - `source = supplier ?? 'PO #<short-id>'`
     - `acquiredAt = today` (date)
     - `createdBy = current user`
   - Insert matching `purchase_order_received_items` row linking the new `inventoryItemId` to this line.
4. **Increment** the line's `quantityReceived` by `n`.
5. **If every line in the PO has `quantityReceived >= quantityOrdered`**: update PO `status = 'received'`, set `receivedAt = now`.

All five steps are one transaction; on partial failure the whole receive rolls back, no orphan SKUs.

### Over-receive (quantityReceived > quantityOrdered)

Allowed — operators occasionally get extras from a supplier. UI shows a small warning chip `+2 over ordered` on the line. The PO still flips to `received` once every line's received count meets-or-exceeds ordered.

### Partial receive

`quantityReceived < quantityOrdered` — line stays in the parent PO's `ordered` state. The line shows a progress chip `Received 4/10`. Hitting `Receive` again later for the remainder works the same way.

### Cancel-receive

Visible on a line in a `received`-status PO as long as **at least one SKU generated from this line is still `status = 'available'`** (i.e., not yet listed / sold).

1. Soft-delete (`deletedAt = now`) every `available` `inventory_items` row linked to this line via `purchase_order_received_items`.
2. Decrement the line's `quantityReceived` by the count soft-deleted.
3. If PO `status = 'received'`, flip back to `ordered`, clear `receivedAt`.

SKUs already `listed`/`sold`/`shipped` are untouched and stay counted as received. This makes cancel-receive the "I just unboxed and these are wrong" undo, not a way to retroactively unwind sold inventory.

## Error handling

- API: every handler wraps in the existing `wrap()` helper, returns `{ error }` with appropriate status on failure.
- UI: each fetch goes through `src/api.js` (extend the `api` object with `purchaseOrders.*` and `speciesPhotos.*` methods). Errors propagate to a toast (list view), an inline error in the detail modal, or a sticky banner on the receive flow.
- Validation:
  - `quantityOrdered`, `quantityReceived` must be non-negative integers.
  - `unitWholesalePrice` must be a non-negative number with up to 2 decimals.
  - `shippingFee` must be a non-negative number.
  - `supplier`, `notes` are free-text, max 500 chars.

## Testing

No automated test framework in this repo. Manual smoke test plan:

1. **Catalog edit** — open a species card, add wholesale + ideal price, save, reopen → values persist.
2. **Photo upload** — upload 3 photos, reorder via drag, set primary, delete the primary → second-in-order becomes primary visually (because `primaryPhotoId` was cleared on delete).
3. **Create draft** — tap "+ Add to draft" on a plant from Catalog → draft mini-bar appears with 1 plant / 1 unit / cost = wholesale.
4. **Add same plant again** — count increments, no duplicate line.
5. **Mark ordered** — flips to `ordered`, lines lock, mini-bar disappears (since the draft is gone).
6. **Receive line partial** — type 5 into a `10` line, hit Receive → `inventory_items` shows 5 new SKUs with `grossCost = unitWholesalePrice + perUnitShipping`, line shows `Received 5/10`, PO still `ordered`.
7. **Receive remainder** — type 5 more, hit Receive → 5 more SKUs created; if all other lines are full, PO flips to `received`.
8. **Cancel-receive on a fully-received line** — soft-deletes any still-`available` SKUs, decrements count, PO flips back to `ordered` if it was `received`. Items already `listed`/`sold` stay.
9. **Over-receive** — type 12 into a `10` line, hit Receive → 12 SKUs created, warning chip shown, PO can still flip to received once every line meets-or-exceeds.
10. **Mark all received** — fresh `ordered` PO, hit "Mark all received" → every line receives its remaining qty, PO flips to `received`.
11. **Delete a draft** → row disappears from list, `purchase_order_lines` cascade-deleted.
12. **Audit trace** — pick a SKU from inventory, look up `purchase_order_received_items` by `inventoryItemId` → returns the originating `lineId` and PO.

## Migration / rollout

- The existing `src/purchasing/PurchaseOrderView.jsx` is deleted in the same PR that adds `PurchasingView.jsx`. Same export name on the new file isn't required since `App.jsx` lazy-imports by path; the import path is updated.
- The existing `localStorage` key `purchase-order-draft-v1` is no longer read. Left in place; one-time forfeit if the operator had an in-flight cart.
- No user-facing migration toast.

## Open questions

None. All decisions resolved in the brainstorming conversation of 2026-05-22:

- Q1: Catalog vs species → extend species table.
- Q2: Supplier model → free-text on PO header.
- Q3: Receive flow → one-click "Receive all" per line, with editable received qty.
- Q4: PO lifecycle → draft / ordered / received (no separate partial state — lives on lines).
- Q5: Shipping cost → tracked on PO, allocated per unit on receive.
- Q6: Photos → multiple with a primary.
- Q7: Pricing → keep both `idealSellingPrice` (catalog) and `profitRate` (existing fallback).
- Q8: UX shape → two sub-tabs (Catalog | Orders).
- Q9: Audit link → keep `purchase_order_received_items`.
