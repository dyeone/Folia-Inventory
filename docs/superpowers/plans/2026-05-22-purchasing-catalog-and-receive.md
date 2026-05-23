# Purchasing rewrite — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only CSV-exporting Purchase tab with a real catalog-and-PO workflow: browseable plants with photos + wholesale/ideal prices, draft → ordered → received POs, and receive-to-inventory that auto-generates SKUs with shipping allocated per unit.

**Architecture:** Extend the existing `species` table (no parallel taxonomy). Add four new tables (`species_photos`, `purchase_orders`, `purchase_order_lines`, `purchase_order_received_items`). One new action-dispatched `/api/purchase-orders` endpoint, one new `/api/species-photos` endpoint, and extensions to `/api/species`. New React component tree under `src/purchasing/` with two sub-tabs (Catalog | Orders), replacing the existing `PurchaseOrderView.jsx`.

**Tech Stack:** React 18 + Vite + Tailwind. Vercel serverless functions (`api/*.js`). Supabase (Postgres + Storage). lucide-react icons. No automated test framework — each task ends with a manual verification step against the spec's smoke test plan.

**Spec:** `docs/superpowers/specs/2026-05-22-purchasing-catalog-and-receive-design.md`

---

## File map

**New files:**
- `supabase/migrations/0015_purchasing_redesign.sql` — all schema changes (idempotent)
- `api/purchase-orders.js` — action-dispatched PO endpoint
- `api/species-photos.js` — photo upload/delete/reorder
- `src/purchasing/PurchasingView.jsx` — top-level tab component with sub-tab routing
- `src/purchasing/CatalogPane.jsx` — Catalog sub-tab (grid + filters)
- `src/purchasing/CatalogPlantCard.jsx` — individual plant card
- `src/purchasing/PlantDetailModal.jsx` — edit modal hosting `PhotoGallery`
- `src/purchasing/PhotoGallery.jsx` — multi-photo CRUD widget
- `src/purchasing/OrdersPane.jsx` — Orders sub-tab (list + expanded details)
- `src/purchasing/PurchaseOrderCard.jsx` — collapsed row + expanded detail
- `src/purchasing/PurchaseOrderLineRow.jsx` — single line within a PO
- `src/purchasing/DraftMiniBar.jsx` — sticky bottom bar on Catalog tab

**Modified files:**
- `supabase/schema.sql` — additive mirror of the migration
- `api/species.js` — accept `wholesalePrice`/`idealSellingPrice`/`primaryPhotoId`; return `photos: [...]`
- `src/api.js` — extend with `purchaseOrders.*` and `speciesPhotos.*` methods
- `src/App.jsx` — swap lazy import from `PurchaseOrderView` to `PurchasingView`

**Deleted files:**
- `src/purchasing/PurchaseOrderView.jsx` — after the new tab is wired up

---

## Manual verification

This repo has **no automated test framework**. Each task ends with one or more concrete smoke-test steps from the spec's section 9 ("Testing"). When a task says "Manually verify", actually open the app and exercise the listed steps. Don't mark the task complete on the basis of "the code compiles."

The dev server runs with `npm run dev`. Supabase migrations are applied via `psql` against the live database (the repo uses prod Supabase as its only environment — there is no local Supabase).

---

## Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/0015_purchasing_redesign.sql`
- Modify: `supabase/schema.sql` (append the new tables + species columns to mirror the migration)

- [ ] **Step 1: Create the migration file**

Create `supabase/migrations/0015_purchasing_redesign.sql` with the full migration content:

```sql
-- 0015 · Purchasing rewrite — catalog fields on species, photos table,
-- purchase orders, lines, and received-items audit link.
--
-- Spec: docs/superpowers/specs/2026-05-22-purchasing-catalog-and-receive-design.md
-- Idempotent — safe to re-run.

-- ─── Catalog: extend species ────────────────────────────────────────────────
-- wholesalePrice + idealSellingPrice power the buyable-plant catalog.
-- primaryPhotoId is a soft reference into species_photos (no FK to avoid
-- the circular delete dance — null means "first uploaded photo wins").
alter table species add column if not exists "wholesalePrice"    numeric;
alter table species add column if not exists "idealSellingPrice" numeric;
alter table species add column if not exists "primaryPhotoId"    text;

-- ─── species_photos ────────────────────────────────────────────────────────
create table if not exists species_photos (
  id            text        primary key,
  "speciesId"   text        not null references species(id) on delete cascade,
  "storagePath" text        not null,
  "sortOrder"   integer     not null default 0,
  "createdAt"   timestamptz not null default now(),
  "createdBy"   text
);
create index if not exists species_photos_species_idx
  on species_photos ("speciesId", "sortOrder");

-- ─── purchase_orders ───────────────────────────────────────────────────────
create table if not exists purchase_orders (
  id             text        primary key,
  supplier       text        not null default '',
  status         text        not null default 'draft'
                              check (status in ('draft','ordered','received')),
  "orderedAt"    timestamptz,
  "receivedAt"   timestamptz,
  "shippingFee"  numeric     not null default 0,
  notes          text,
  "createdAt"    timestamptz not null default now(),
  "createdBy"    text,
  "modifiedAt"   timestamptz,
  "modifiedBy"   text,
  "deletedAt"    timestamptz
);
create index if not exists purchase_orders_status_created_idx
  on purchase_orders (status, "createdAt" desc);

-- ─── purchase_order_lines ──────────────────────────────────────────────────
-- One row per (PO, species). unique constraint lets the client safely
-- treat "Add to draft" as an upsert that bumps quantityOrdered.
create table if not exists purchase_order_lines (
  id                    text    primary key,
  "purchaseOrderId"     text    not null references purchase_orders(id) on delete cascade,
  "speciesId"           text    not null references species(id) on delete restrict,
  "quantityOrdered"     integer not null check ("quantityOrdered" > 0),
  "quantityReceived"    integer not null default 0 check ("quantityReceived" >= 0),
  "unitWholesalePrice"  numeric not null,
  "sortOrder"           integer not null default 0,
  unique ("purchaseOrderId", "speciesId")
);
create index if not exists purchase_order_lines_po_idx
  on purchase_order_lines ("purchaseOrderId", "sortOrder");

-- ─── purchase_order_received_items ─────────────────────────────────────────
-- Audit link from each generated inventory_items row back to its PO line.
-- Lets the UI show "5 SKUs from this line" and supports cancel-receive
-- (which soft-deletes the still-available SKUs originating here).
create table if not exists purchase_order_received_items (
  id                 text        primary key,
  "lineId"           text        not null references purchase_order_lines(id) on delete cascade,
  "inventoryItemId"  text        not null references inventory_items(id) on delete cascade,
  "receivedAt"       timestamptz not null default now(),
  "receivedBy"       text,
  unique ("inventoryItemId")
);
create index if not exists purchase_order_received_items_line_idx
  on purchase_order_received_items ("lineId");

-- ─── RLS ───────────────────────────────────────────────────────────────────
-- Defense-in-depth. All API access uses service role and bypasses RLS.
alter table species_photos                  enable row level security;
alter table purchase_orders                 enable row level security;
alter table purchase_order_lines            enable row level security;
alter table purchase_order_received_items   enable row level security;

insert into applied_migrations (id) values ('0015_purchasing_redesign')
  on conflict (id) do nothing;
```

- [ ] **Step 2: Mirror the schema into `supabase/schema.sql`**

Append to `supabase/schema.sql` (after the existing `species` block, before the "Constraints" section):

```sql
-- ─── Purchasing: catalog fields, photos, POs, lines, received-items audit ──
alter table species add column if not exists "wholesalePrice"    numeric;
alter table species add column if not exists "idealSellingPrice" numeric;
alter table species add column if not exists "primaryPhotoId"    text;

create table if not exists species_photos (
  id            text        primary key,
  "speciesId"   text        not null references species(id) on delete cascade,
  "storagePath" text        not null,
  "sortOrder"   integer     not null default 0,
  "createdAt"   timestamptz not null default now(),
  "createdBy"   text
);
create index if not exists species_photos_species_idx
  on species_photos ("speciesId", "sortOrder");

create table if not exists purchase_orders (
  id             text        primary key,
  supplier       text        not null default '',
  status         text        not null default 'draft'
                              check (status in ('draft','ordered','received')),
  "orderedAt"    timestamptz,
  "receivedAt"   timestamptz,
  "shippingFee"  numeric     not null default 0,
  notes          text,
  "createdAt"    timestamptz not null default now(),
  "createdBy"    text,
  "modifiedAt"   timestamptz,
  "modifiedBy"   text,
  "deletedAt"    timestamptz
);
create index if not exists purchase_orders_status_created_idx
  on purchase_orders (status, "createdAt" desc);

create table if not exists purchase_order_lines (
  id                    text    primary key,
  "purchaseOrderId"     text    not null references purchase_orders(id) on delete cascade,
  "speciesId"           text    not null references species(id) on delete restrict,
  "quantityOrdered"     integer not null check ("quantityOrdered" > 0),
  "quantityReceived"    integer not null default 0 check ("quantityReceived" >= 0),
  "unitWholesalePrice"  numeric not null,
  "sortOrder"           integer not null default 0,
  unique ("purchaseOrderId", "speciesId")
);
create index if not exists purchase_order_lines_po_idx
  on purchase_order_lines ("purchaseOrderId", "sortOrder");

create table if not exists purchase_order_received_items (
  id                 text        primary key,
  "lineId"           text        not null references purchase_order_lines(id) on delete cascade,
  "inventoryItemId"  text        not null references inventory_items(id) on delete cascade,
  "receivedAt"       timestamptz not null default now(),
  "receivedBy"       text,
  unique ("inventoryItemId")
);
create index if not exists purchase_order_received_items_line_idx
  on purchase_order_received_items ("lineId");

alter table species_photos                enable row level security;
alter table purchase_orders               enable row level security;
alter table purchase_order_lines          enable row level security;
alter table purchase_order_received_items enable row level security;
```

- [ ] **Step 3: Apply the migration to Supabase**

Open the Supabase Dashboard → SQL Editor → paste the migration content from Step 1 → Run. Expected: `Success. No rows returned.`

- [ ] **Step 4: Manually verify the migration landed**

In SQL Editor:

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('species_photos','purchase_orders','purchase_order_lines','purchase_order_received_items')
order by table_name;
```

Expected: 4 rows.

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='species'
  and column_name in ('wholesalePrice','idealSellingPrice','primaryPhotoId');
```

Expected: 3 rows.

- [ ] **Step 5: Create the `plant-photos` Storage bucket**

Supabase Dashboard → Storage → New bucket → name `plant-photos`, public read enabled, file size limit 10 MB.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0015_purchasing_redesign.sql supabase/schema.sql
git commit -m "purchasing: schema migration 0015 (catalog fields + POs + receive audit)"
```

---

## Task 2: API — extend `/api/species` for catalog fields + photos

**Files:**
- Modify: `api/species.js`

The `GET` should return each species with a `photos: [...]` array. `POST` and `PATCH` should accept the new pricing fields.

- [ ] **Step 1: Replace the `GET` handler to join photos**

In `api/species.js`, find the `case 'GET'` block and replace it with:

```js
    case 'GET': {
      const { data: species, error } = await supabase
        .from('species')
        .select('*')
        .order('epithet');
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      const ids = (species || []).map(s => s.id);
      let photos = [];
      if (ids.length) {
        const { data: p, error: pe } = await supabase
          .from('species_photos')
          .select('id, "speciesId", "storagePath", "sortOrder"')
          .in('speciesId', ids)
          .order('sortOrder');
        if (pe) { const e = new Error(pe.message); e.status = 500; throw e; }
        photos = p || [];
      }
      // Group photos by speciesId so the client doesn't have to.
      const photosBySpecies = new Map();
      for (const ph of photos) {
        if (!photosBySpecies.has(ph.speciesId)) photosBySpecies.set(ph.speciesId, []);
        photosBySpecies.get(ph.speciesId).push(ph);
      }
      const out = (species || []).map(s => ({
        ...s,
        photos: photosBySpecies.get(s.id) || [],
      }));
      return res.status(200).json({ species: out });
    }
```

(Note: the API returns `storagePath`, not a signed URL — the photos endpoint will mint signed URLs on demand, and the catalog UI does the same. Single GET vs. one-signed-URL-per-photo here is intentional: a 100-plant catalog with 3 photos each would be 300 signed-URL calls per page load.)

- [ ] **Step 2: Extend the `POST` handler to accept catalog fields**

Replace the `case 'POST'` block with:

```js
    case 'POST': {
      const { varietyId, epithet, commonName, notes, imageUrl,
              wholesalePrice, idealSellingPrice } = req.body || {};
      if (!varietyId) { const e = new Error('varietyId required'); e.status = 400; throw e; }
      const cleanEpithet = String(epithet || '').trim();
      if (!cleanEpithet) { const e = new Error('epithet required'); e.status = 400; throw e; }
      const { data: vrow } = await supabase
        .from('varieties').select('id').eq('id', varietyId).maybeSingle();
      if (!vrow) { const e = new Error('Unknown variety'); e.status = 400; throw e; }

      const parseMoney = (v, name) => {
        if (v === undefined || v === null || v === '') return null;
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n < 0) {
          const e = new Error(`${name} must be a non-negative number`); e.status = 400; throw e;
        }
        return n;
      };

      const row = {
        id: newId(),
        varietyId,
        epithet: cleanEpithet,
        commonName: commonName ? String(commonName).trim() : null,
        notes: notes ? String(notes) : null,
        imageUrl: imageUrl ? String(imageUrl).trim() : null,
        wholesalePrice: parseMoney(wholesalePrice, 'wholesalePrice'),
        idealSellingPrice: parseMoney(idealSellingPrice, 'idealSellingPrice'),
        createdAt: new Date().toISOString(),
        createdBy: user.displayName,
      };
      const { error } = await supabase.from('species').insert(row);
      if (error) {
        if (error.code === '23505') {
          const e = new Error(`Species "${cleanEpithet}" already exists in this variety`); e.status = 409; throw e;
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }
      return res.status(200).json({ species: { ...row, photos: [] } });
    }
```

- [ ] **Step 3: Extend the `PATCH` handler**

Replace the `case 'PATCH'` block. The new fields (`wholesalePrice`, `idealSellingPrice`, `primaryPhotoId`) are operational — any active user can change them (no admin gate). Structural changes (`varietyId`, `epithet`, etc.) still require admin.

```js
    case 'PATCH': {
      const { id, varietyId, epithet, commonName, notes, imageUrl, profitRate,
              wholesalePrice, idealSellingPrice, primaryPhotoId } = req.body || {};
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      const wantsStructural = varietyId !== undefined || epithet !== undefined
        || commonName !== undefined || notes !== undefined || imageUrl !== undefined;
      if (wantsStructural) await requireAdmin(userId);

      const parseMoneyOrNull = (v, name) => {
        if (v === null || v === '') return null;
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n < 0) {
          const e = new Error(`${name} must be a non-negative number`); e.status = 400; throw e;
        }
        return n;
      };

      const patch = {};
      if (varietyId !== undefined) patch.varietyId = varietyId;
      if (epithet !== undefined) patch.epithet = String(epithet).trim();
      if (commonName !== undefined) patch.commonName = commonName ? String(commonName).trim() : null;
      if (notes !== undefined) patch.notes = notes || null;
      if (imageUrl !== undefined) patch.imageUrl = imageUrl ? String(imageUrl).trim() : null;
      if (profitRate !== undefined) {
        if (profitRate === null || profitRate === '') {
          patch.profitRate = null;
        } else {
          const n = parseFloat(profitRate);
          if (!Number.isFinite(n)) { const e = new Error('profitRate must be a number'); e.status = 400; throw e; }
          patch.profitRate = n;
        }
      }
      if (wholesalePrice    !== undefined) patch.wholesalePrice    = parseMoneyOrNull(wholesalePrice,    'wholesalePrice');
      if (idealSellingPrice !== undefined) patch.idealSellingPrice = parseMoneyOrNull(idealSellingPrice, 'idealSellingPrice');
      if (primaryPhotoId    !== undefined) patch.primaryPhotoId    = primaryPhotoId || null;

      if (Object.keys(patch).length === 0) {
        const e = new Error('No fields to update'); e.status = 400; throw e;
      }

      const { error } = await supabase.from('species').update(patch).eq('id', id);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }

      // Sync the denormalized item.name/variety so display + search stay
      // accurate when an admin renames a species. (unchanged from before)
      if (patch.epithet !== undefined || patch.varietyId !== undefined) {
        const { data: srow } = await supabase
          .from('species').select('epithet, varietyId').eq('id', id).maybeSingle();
        if (srow) {
          const sync = {};
          if (patch.epithet !== undefined) sync.name = srow.epithet;
          if (patch.varietyId !== undefined) {
            const { data: vrow } = await supabase
              .from('varieties').select('name').eq('id', srow.varietyId).maybeSingle();
            if (vrow) sync.variety = vrow.name;
          }
          if (Object.keys(sync).length > 0) {
            await supabase.from('inventory_items').update(sync).eq('speciesId', id);
          }
        }
      }
      return res.status(200).json({ ok: true });
    }
```

- [ ] **Step 4: Manually verify via curl**

Start the dev server (`npm run dev`). Find your `userId` from the browser app (open DevTools → localStorage → `session-current-user` → copy the `id` field).

```bash
# Find an existing species id from the GET response.
curl -s "http://localhost:5173/api/species?userId=$USER_ID" | jq '.species[0]'
```

Expected: a JSON object that now includes `wholesalePrice`, `idealSellingPrice`, `primaryPhotoId` (all null), and `photos: []`.

```bash
# PATCH a wholesalePrice onto it.
curl -s -X PATCH "http://localhost:5173/api/species" \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"id\":\"$SPECIES_ID\",\"wholesalePrice\":12.50}"
```

Expected: `{"ok":true}`. Re-running the GET should now show `wholesalePrice: 12.5`.

- [ ] **Step 5: Commit**

```bash
git add api/species.js
git commit -m "api/species: accept wholesale/ideal price + return photos array"
```

---

## Task 3: API — `/api/species-photos` endpoint

**Files:**
- Create: `api/species-photos.js`

Action-dispatched. Three actions: `upload`, `delete`, `reorder`. Uploads land in the `plant-photos` bucket (created in Task 1).

- [ ] **Step 1: Create the endpoint file**

Create `api/species-photos.js`:

```js
import { supabase, requireUser, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Photo CRUD for a catalog plant (species row). Three actions:
//   POST ?action=upload   { speciesId, fileBase64, contentType, filename? }
//   POST ?action=delete   { id }
//   POST ?action=reorder  { speciesId, orderedPhotoIds: [...] }
//
// Storage bucket = 'plant-photos'. Path convention: `<speciesId>/<photoId>.<ext>`.
// Read access is via /api/species-photos?action=signed-url&id=... (5-minute TTL).

const STORAGE_BUCKET = 'plant-photos';
const SIGNED_URL_TTL_SECONDS = 300;

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'signed-url') return signedUrl(req, res);
    const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
    if (action === 'upload')  return upload(req, res, user);
    if (action === 'delete')  return remove(req, res);
    if (action === 'reorder') return reorder(req, res);
    const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});

async function signedUrl(req, res) {
  const id = req.query?.id;
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data: row, error } = await supabase
    .from('species_photos')
    .select('"storagePath"')
    .eq('id', id)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row)  { const e = new Error('Photo not found'); e.status = 404; throw e; }

  const { data: signed, error: sErr } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(row.storagePath, SIGNED_URL_TTL_SECONDS);
  if (sErr) { const e = new Error(sErr.message); e.status = 500; throw e; }
  return res.status(200).json({ url: signed.signedUrl });
}

async function upload(req, res, user) {
  const { speciesId, fileBase64, contentType, filename } = req.body || {};
  if (!speciesId)   { const e = new Error('speciesId required');   e.status = 400; throw e; }
  if (!fileBase64)  { const e = new Error('fileBase64 required');  e.status = 400; throw e; }
  if (!contentType) { const e = new Error('contentType required'); e.status = 400; throw e; }

  const { data: sp, error: spErr } = await supabase
    .from('species').select('id, "imageUrl"').eq('id', speciesId).maybeSingle();
  if (spErr) { const e = new Error(spErr.message); e.status = 500; throw e; }
  if (!sp)   { const e = new Error('Unknown species'); e.status = 404; throw e; }

  // Find next sortOrder for this species.
  const { data: existing, error: exErr } = await supabase
    .from('species_photos')
    .select('"sortOrder"')
    .eq('speciesId', speciesId)
    .order('sortOrder', { ascending: false })
    .limit(1);
  if (exErr) { const e = new Error(exErr.message); e.status = 500; throw e; }
  const nextSort = existing && existing[0] ? existing[0].sortOrder + 1 : 0;

  // Decode + upload to storage.
  const buf = Buffer.from(String(fileBase64), 'base64');
  if (buf.length === 0) { const e = new Error('Empty file'); e.status = 400; throw e; }

  const ext = (filename && filename.includes('.') ? filename.split('.').pop() : 'jpg')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = newId();
  const storagePath = `${speciesId}/${id}.${ext || 'jpg'}`;

  const { error: upErr } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buf, { contentType, upsert: false });
  if (upErr) { const e = new Error(upErr.message); e.status = 500; throw e; }

  // Insert the row.
  const row = {
    id,
    speciesId,
    storagePath,
    sortOrder: nextSort,
    createdAt: new Date().toISOString(),
    createdBy: user.displayName,
  };
  const { error: insErr } = await supabase.from('species_photos').insert(row);
  if (insErr) {
    // Roll back the storage object if the row insert failed.
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
    const e = new Error(insErr.message); e.status = 500; throw e;
  }

  // Lazy migration: if the species still has a legacy imageUrl, this is
  // the moment to move it into a species_photos row too (so the catalog
  // UI stops needing the fallback path for this species).
  if (sp.imageUrl) {
    const legacyId = newId();
    await supabase.from('species_photos').insert({
      id: legacyId,
      speciesId,
      storagePath: sp.imageUrl, // legacy URL stored as-is; signed-url path handles
      sortOrder: -1,
      createdAt: new Date().toISOString(),
      createdBy: user.displayName,
    }).then(() => supabase.from('species').update({ imageUrl: null }).eq('id', speciesId))
      .catch(() => { /* best-effort migration; if it fails, fallback path still works */ });
  }

  // Mint a signed URL so the client can show the photo immediately.
  const { data: signed } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  return res.status(200).json({ photo: row, signedUrl: signed?.signedUrl || null });
}

async function remove(req, res) {
  const { id } = req.body || {};
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data: row, error } = await supabase
    .from('species_photos')
    .select('id, "speciesId", "storagePath"')
    .eq('id', id)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row)  { const e = new Error('Photo not found'); e.status = 404; throw e; }

  // Remove the storage object first; if the row delete then fails we
  // get an orphan record but no orphan blob (the smaller of the two
  // possible orphans, and the next photo CRUD on this species cleans
  // it up implicitly).
  await supabase.storage.from(STORAGE_BUCKET).remove([row.storagePath]).catch(() => {});
  const { error: delErr } = await supabase.from('species_photos').delete().eq('id', id);
  if (delErr) { const e = new Error(delErr.message); e.status = 500; throw e; }

  // If the deleted photo was the species's primary, clear that field —
  // the catalog UI will fall back to the next photo by sortOrder.
  await supabase.from('species')
    .update({ primaryPhotoId: null })
    .eq('id', row.speciesId)
    .eq('primaryPhotoId', id);

  return res.status(200).json({ ok: true });
}

async function reorder(req, res) {
  const { speciesId, orderedPhotoIds } = req.body || {};
  if (!speciesId) { const e = new Error('speciesId required'); e.status = 400; throw e; }
  if (!Array.isArray(orderedPhotoIds)) {
    const e = new Error('orderedPhotoIds must be an array'); e.status = 400; throw e;
  }
  // Write each row's new sortOrder. Bounded by the array length (small),
  // so per-row writes are fine — no need for a stored proc.
  for (let i = 0; i < orderedPhotoIds.length; i++) {
    const { error } = await supabase
      .from('species_photos')
      .update({ sortOrder: i })
      .eq('id', orderedPhotoIds[i])
      .eq('speciesId', speciesId);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  }
  return res.status(200).json({ ok: true });
}
```

- [ ] **Step 2: Manually verify upload via curl**

Encode a tiny test image as base64 and POST it:

```bash
B64=$(base64 -i path/to/any/small.jpg)
curl -s -X POST http://localhost:5173/api/species-photos \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"upload\",\"speciesId\":\"$SPECIES_ID\",\"contentType\":\"image/jpeg\",\"filename\":\"test.jpg\",\"fileBase64\":\"$B64\"}" | jq .
```

Expected: `{ photo: {...}, signedUrl: "https://..." }`. Open the `signedUrl` in a browser — should display the image.

Verify it shows up via the species GET:

```bash
curl -s "http://localhost:5173/api/species?userId=$USER_ID" \
  | jq ".species[] | select(.id==\"$SPECIES_ID\") | .photos"
```

Expected: array containing the row.

- [ ] **Step 3: Commit**

```bash
git add api/species-photos.js
git commit -m "api/species-photos: upload/delete/reorder + signed-url helper"
```

---

## Task 4: API — `/api/purchase-orders` (draft CRUD)

**Files:**
- Create: `api/purchase-orders.js`

First slice — the actions that operate on draft POs only. Lifecycle/receive actions land in Tasks 5–6.

- [ ] **Step 1: Create the endpoint with draft-CRUD actions**

Create `api/purchase-orders.js`:

```js
import { supabase, requireUser, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Purchase orders. Action-dispatched. See:
//   docs/superpowers/specs/2026-05-22-purchasing-catalog-and-receive-design.md

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'get') return getOne(req, res);
    return list(req, res); // default GET
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
    switch (action) {
      case 'create':         return create(req, res, user);
      case 'update-header':  return updateHeader(req, res, user);
      case 'add-line':       return addLine(req, res);
      case 'update-line':    return updateLine(req, res);
      case 'remove-line':    return removeLine(req, res);
      case 'delete':         return softDelete(req, res, user);
      // lifecycle actions added in tasks 5-6:
      case 'mark-ordered':         return markOrdered(req, res, user);
      case 'receive-line':         return receiveLine(req, res, user);
      case 'cancel-receive-line':  return cancelReceiveLine(req, res, user);
      default: { const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e; }
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function loadPo(id) {
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*')
    .eq('id', id)
    .is('deletedAt', null)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!data) { const e = new Error('Purchase order not found'); e.status = 404; throw e; }
  return data;
}

function requireStatus(po, allowed) {
  if (!allowed.includes(po.status)) {
    const e = new Error(`Cannot do this while PO is "${po.status}" (allowed: ${allowed.join(', ')})`);
    e.status = 409; throw e;
  }
}

// ─── list / get ─────────────────────────────────────────────────────────────

async function list(req, res) {
  const statuses = (req.query?.status || 'draft,ordered')
    .split(',').map(s => s.trim()).filter(Boolean);
  const { data: pos, error } = await supabase
    .from('purchase_orders')
    .select('*')
    .in('status', statuses)
    .is('deletedAt', null)
    .order('createdAt', { ascending: false });
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }

  // Add line + unit counts so the list view doesn't need a per-PO fetch.
  const ids = (pos || []).map(p => p.id);
  let lineRows = [];
  if (ids.length) {
    const { data: lines, error: lErr } = await supabase
      .from('purchase_order_lines')
      .select('"purchaseOrderId", "quantityOrdered"')
      .in('purchaseOrderId', ids);
    if (lErr) { const e = new Error(lErr.message); e.status = 500; throw e; }
    lineRows = lines || [];
  }
  const tally = new Map();
  for (const l of lineRows) {
    const t = tally.get(l.purchaseOrderId) || { lineCount: 0, unitCount: 0 };
    t.lineCount += 1;
    t.unitCount += l.quantityOrdered;
    tally.set(l.purchaseOrderId, t);
  }
  const out = (pos || []).map(p => ({
    ...p,
    lineCount: tally.get(p.id)?.lineCount || 0,
    unitCount: tally.get(p.id)?.unitCount || 0,
  }));
  return res.status(200).json({ purchaseOrders: out });
}

async function getOne(req, res) {
  const po = await loadPo(req.query?.id);
  const { data: lines, error: lErr } = await supabase
    .from('purchase_order_lines')
    .select('*')
    .eq('purchaseOrderId', po.id)
    .order('sortOrder');
  if (lErr) { const e = new Error(lErr.message); e.status = 500; throw e; }
  const lineIds = (lines || []).map(l => l.id);
  let received = [];
  if (lineIds.length) {
    const { data: r, error: rErr } = await supabase
      .from('purchase_order_received_items')
      .select('*')
      .in('lineId', lineIds);
    if (rErr) { const e = new Error(rErr.message); e.status = 500; throw e; }
    received = r || [];
  }
  return res.status(200).json({ purchaseOrder: po, lines: lines || [], receivedItems: received });
}

// ─── header writes ──────────────────────────────────────────────────────────

async function create(req, res, user) {
  const { supplier, shippingFee, notes } = req.body || {};
  const row = {
    id: newId(),
    supplier: String(supplier || '').slice(0, 500),
    status: 'draft',
    shippingFee: parseFloat(shippingFee || 0) || 0,
    notes: notes ? String(notes).slice(0, 500) : null,
    createdAt: new Date().toISOString(),
    createdBy: user.displayName,
  };
  const { error } = await supabase.from('purchase_orders').insert(row);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ purchaseOrder: row });
}

async function updateHeader(req, res, user) {
  const { id, supplier, shippingFee, notes } = req.body || {};
  const po = await loadPo(id);
  requireStatus(po, ['draft', 'ordered']);
  const patch = { modifiedAt: new Date().toISOString(), modifiedBy: user.displayName };
  if (supplier    !== undefined) patch.supplier    = String(supplier || '').slice(0, 500);
  if (shippingFee !== undefined) {
    const n = parseFloat(shippingFee);
    if (!Number.isFinite(n) || n < 0) { const e = new Error('shippingFee must be ≥ 0'); e.status = 400; throw e; }
    patch.shippingFee = n;
  }
  if (notes       !== undefined) patch.notes = notes ? String(notes).slice(0, 500) : null;
  const { error } = await supabase.from('purchase_orders').update(patch).eq('id', id);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ purchaseOrder: { ...po, ...patch } });
}

async function softDelete(req, res, user) {
  const { id } = req.body || {};
  const po = await loadPo(id);
  requireStatus(po, ['draft']);
  const { error } = await supabase
    .from('purchase_orders')
    .update({ deletedAt: new Date().toISOString(), modifiedBy: user.displayName })
    .eq('id', id);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true });
}

// ─── lines ──────────────────────────────────────────────────────────────────

async function addLine(req, res) {
  const { id, speciesId, quantityOrdered, unitWholesalePrice } = req.body || {};
  const po = await loadPo(id);
  requireStatus(po, ['draft']);
  if (!speciesId) { const e = new Error('speciesId required'); e.status = 400; throw e; }
  const qty = parseInt(quantityOrdered, 10) || 1;
  if (qty < 1) { const e = new Error('quantityOrdered must be ≥ 1'); e.status = 400; throw e; }

  // Resolve price: explicit param > species.wholesalePrice > 0.
  let price = (unitWholesalePrice === undefined || unitWholesalePrice === null || unitWholesalePrice === '')
    ? null
    : parseFloat(unitWholesalePrice);
  if (price === null) {
    const { data: sp, error: spErr } = await supabase
      .from('species').select('"wholesalePrice"').eq('id', speciesId).maybeSingle();
    if (spErr) { const e = new Error(spErr.message); e.status = 500; throw e; }
    if (!sp)   { const e = new Error('Unknown species'); e.status = 404; throw e; }
    price = sp.wholesalePrice ?? 0;
  }
  if (!Number.isFinite(price) || price < 0) {
    const e = new Error('unitWholesalePrice must be ≥ 0'); e.status = 400; throw e;
  }

  // Upsert behavior: if a line for this (PO, species) already exists,
  // bump its quantityOrdered. Detect via the unique index error.
  const { data: existing, error: exErr } = await supabase
    .from('purchase_order_lines')
    .select('*')
    .eq('purchaseOrderId', id)
    .eq('speciesId', speciesId)
    .maybeSingle();
  if (exErr) { const e = new Error(exErr.message); e.status = 500; throw e; }

  if (existing) {
    const next = { quantityOrdered: existing.quantityOrdered + qty };
    const { error } = await supabase
      .from('purchase_order_lines').update(next).eq('id', existing.id);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    return res.status(200).json({ line: { ...existing, ...next } });
  }

  // Compute next sortOrder.
  const { data: last } = await supabase
    .from('purchase_order_lines')
    .select('"sortOrder"')
    .eq('purchaseOrderId', id)
    .order('sortOrder', { ascending: false })
    .limit(1);
  const nextSort = last && last[0] ? last[0].sortOrder + 1 : 0;

  const row = {
    id: newId(),
    purchaseOrderId: id,
    speciesId,
    quantityOrdered: qty,
    quantityReceived: 0,
    unitWholesalePrice: price,
    sortOrder: nextSort,
  };
  const { error } = await supabase.from('purchase_order_lines').insert(row);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ line: row });
}

async function updateLine(req, res) {
  const { id, lineId, quantityOrdered, unitWholesalePrice } = req.body || {};
  const po = await loadPo(id);
  requireStatus(po, ['draft']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }

  const patch = {};
  if (quantityOrdered !== undefined) {
    const n = parseInt(quantityOrdered, 10);
    if (!Number.isFinite(n) || n <= 0) {
      const e = new Error('quantityOrdered must be > 0 (use remove-line to drop a line)'); e.status = 400; throw e;
    }
    patch.quantityOrdered = n;
  }
  if (unitWholesalePrice !== undefined) {
    const n = parseFloat(unitWholesalePrice);
    if (!Number.isFinite(n) || n < 0) {
      const e = new Error('unitWholesalePrice must be ≥ 0'); e.status = 400; throw e;
    }
    patch.unitWholesalePrice = n;
  }
  if (Object.keys(patch).length === 0) {
    const e = new Error('No fields to update'); e.status = 400; throw e;
  }

  const { error } = await supabase
    .from('purchase_order_lines').update(patch).eq('id', lineId).eq('purchaseOrderId', id);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true });
}

async function removeLine(req, res) {
  const { id, lineId } = req.body || {};
  const po = await loadPo(id);
  requireStatus(po, ['draft']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }
  const { error } = await supabase
    .from('purchase_order_lines').delete().eq('id', lineId).eq('purchaseOrderId', id);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true });
}

// ─── placeholders for tasks 5-6 (filled in there) ──────────────────────────

async function markOrdered(req, res, user) {
  const e = new Error('mark-ordered not implemented yet'); e.status = 501; throw e;
}
async function receiveLine(req, res, user) {
  const e = new Error('receive-line not implemented yet'); e.status = 501; throw e;
}
async function cancelReceiveLine(req, res, user) {
  const e = new Error('cancel-receive-line not implemented yet'); e.status = 501; throw e;
}
```

- [ ] **Step 2: Manually verify draft CRUD via curl**

```bash
# Create a draft PO.
PO=$(curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"create\",\"supplier\":\"Test Nursery\",\"shippingFee\":15.00}" \
  | jq -r '.purchaseOrder.id')
echo "PO id: $PO"

# Add a line.
curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"add-line\",\"id\":\"$PO\",\"speciesId\":\"$SPECIES_ID\",\"quantityOrdered\":5}" | jq .

# Add the same plant again — should increment, not duplicate.
curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"add-line\",\"id\":\"$PO\",\"speciesId\":\"$SPECIES_ID\",\"quantityOrdered\":3}" | jq .

# Fetch the PO with lines.
curl -s "http://localhost:5173/api/purchase-orders?action=get&id=$PO&userId=$USER_ID" | jq '.lines'
```

Expected: a single line with `quantityOrdered: 8`.

```bash
# List drafts.
curl -s "http://localhost:5173/api/purchase-orders?status=draft&userId=$USER_ID" | jq '.purchaseOrders'
```

Expected: includes the PO with `lineCount: 1, unitCount: 8`.

```bash
# Soft-delete.
curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"delete\",\"id\":\"$PO\"}" | jq .

# Confirm gone from list.
curl -s "http://localhost:5173/api/purchase-orders?status=draft&userId=$USER_ID" | jq '.purchaseOrders | length'
```

- [ ] **Step 3: Commit**

```bash
git add api/purchase-orders.js
git commit -m "api/purchase-orders: draft CRUD (list/get/create/header/lines/delete)"
```

---

## Task 5: API — `mark-ordered`

**Files:**
- Modify: `api/purchase-orders.js`

Replace the placeholder `markOrdered` implementation with the real one.

- [ ] **Step 1: Implement `markOrdered`**

In `api/purchase-orders.js`, replace the placeholder `markOrdered` function with:

```js
async function markOrdered(req, res, user) {
  const { id } = req.body || {};
  const po = await loadPo(id);
  requireStatus(po, ['draft']);

  // Must have at least one line.
  const { count, error: cErr } = await supabase
    .from('purchase_order_lines')
    .select('id', { count: 'exact', head: true })
    .eq('purchaseOrderId', id);
  if (cErr) { const e = new Error(cErr.message); e.status = 500; throw e; }
  if (!count) { const e = new Error('Cannot mark ordered — PO has no lines'); e.status = 409; throw e; }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status: 'ordered', orderedAt: now, modifiedAt: now, modifiedBy: user.displayName })
    .eq('id', id);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ purchaseOrder: { ...po, status: 'ordered', orderedAt: now } });
}
```

- [ ] **Step 2: Manually verify**

```bash
# Create + line + mark-ordered.
PO=$(curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"create\",\"supplier\":\"Mark-Ordered Test\"}" | jq -r '.purchaseOrder.id')

curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"add-line\",\"id\":\"$PO\",\"speciesId\":\"$SPECIES_ID\",\"quantityOrdered\":2,\"unitWholesalePrice\":10}" > /dev/null

curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"mark-ordered\",\"id\":\"$PO\"}" | jq .
```

Expected: `purchaseOrder.status === "ordered"`, `orderedAt` set.

```bash
# Attempting to add a line now should fail (status != draft).
curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"add-line\",\"id\":\"$PO\",\"speciesId\":\"$SPECIES_ID\",\"quantityOrdered\":1}" | jq .
```

Expected: `error` mentions "Cannot do this while PO is 'ordered'".

- [ ] **Step 3: Commit**

```bash
git add api/purchase-orders.js
git commit -m "api/purchase-orders: mark-ordered action"
```

---

## Task 6: API — `receive-line` + `cancel-receive-line`

**Files:**
- Modify: `api/purchase-orders.js`

The transactional core. Generates inventory_items SKUs, audit rows, allocates shipping per unit, optionally flips PO to `received`.

- [ ] **Step 1: Add a SKU helper at top of file**

In `api/purchase-orders.js`, just below the imports, add:

```js
// Generates the next SKU for a variety code, using the same RPC the
// existing /api/items handler uses. Synchronous in the API request
// path: each call increments the global suffix counter, so a 10-unit
// receive does 10 RPC calls in sequence. Acceptable for shipment-size
// batches; revisit if a single receive ever exceeds a couple hundred.
async function nextSku(varietyCode) {
  const { data, error } = await supabase.rpc('inventory_max_sku_suffix');
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  const next = (data || 0) + 1;
  return `${varietyCode}-${next}`;
}
```

- [ ] **Step 2: Implement `receiveLine`**

Replace the placeholder `receiveLine` function with:

```js
async function receiveLine(req, res, user) {
  const { id, lineId, quantityReceived } = req.body || {};
  const po = await loadPo(id);
  requireStatus(po, ['ordered']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }
  const n = parseInt(quantityReceived, 10);
  if (!Number.isFinite(n) || n <= 0) {
    const e = new Error('quantityReceived must be > 0'); e.status = 400; throw e;
  }

  // Load the line + parent species + variety code (for SKU prefix).
  const { data: line, error: lErr } = await supabase
    .from('purchase_order_lines')
    .select('*')
    .eq('id', lineId)
    .eq('purchaseOrderId', id)
    .maybeSingle();
  if (lErr) { const e = new Error(lErr.message); e.status = 500; throw e; }
  if (!line) { const e = new Error('Line not found'); e.status = 404; throw e; }

  const { data: species, error: spErr } = await supabase
    .from('species')
    .select('id, epithet, "varietyId", "idealSellingPrice"')
    .eq('id', line.speciesId)
    .maybeSingle();
  if (spErr) { const e = new Error(spErr.message); e.status = 500; throw e; }
  if (!species) { const e = new Error('Linked species missing'); e.status = 500; throw e; }

  const { data: variety, error: vErr } = await supabase
    .from('varieties').select('name, code').eq('id', species.varietyId).maybeSingle();
  if (vErr) { const e = new Error(vErr.message); e.status = 500; throw e; }

  // Allocate shipping per unit across ALL lines on this PO.
  const { data: allLines, error: alErr } = await supabase
    .from('purchase_order_lines')
    .select('"quantityOrdered"')
    .eq('purchaseOrderId', id);
  if (alErr) { const e = new Error(alErr.message); e.status = 500; throw e; }
  const totalOrdered = (allLines || []).reduce((s, l) => s + l.quantityOrdered, 0) || 1;
  const perUnitShipping = Math.round(((po.shippingFee || 0) / totalOrdered) * 10000) / 10000;

  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);
  const supplierLabel = po.supplier && po.supplier.trim() ? po.supplier.trim() : `PO #${po.id.slice(-6)}`;

  // Generate N SKUs sequentially. Each one consumes a unique suffix
  // via inventory_max_sku_suffix RPC. Insert items + audit links one
  // at a time so a mid-batch failure leaves a consistent prefix
  // already-received (the line.quantityReceived increment is the last
  // write, so we re-read it on retry to see what's already in).
  const createdIds = [];
  for (let i = 0; i < n; i++) {
    const sku = await nextSku(variety?.code || 'PLT');
    const itemId = newId();
    const itemRow = {
      id: itemId,
      sku,
      type: 'plant',
      name: species.epithet,
      variety: variety?.name || null,
      speciesId: species.id,
      quantity: 1,
      grossCost: Number(line.unitWholesalePrice) + perUnitShipping,
      idealPrice: species.idealSellingPrice ?? null,
      status: 'available',
      lotKind: 'sale',
      source: supplierLabel,
      acquiredAt: todayDate,
      createdAt: nowIso,
      createdBy: user.displayName,
    };
    const { error: insErr } = await supabase.from('inventory_items').insert(itemRow);
    if (insErr) { const e = new Error(`Insert SKU ${sku} failed: ${insErr.message}`); e.status = 500; throw e; }

    const auditRow = {
      id: newId(),
      lineId,
      inventoryItemId: itemId,
      receivedAt: nowIso,
      receivedBy: user.displayName,
    };
    const { error: aErr } = await supabase.from('purchase_order_received_items').insert(auditRow);
    if (aErr) { const e = new Error(`Audit insert failed for ${sku}: ${aErr.message}`); e.status = 500; throw e; }
    createdIds.push(itemId);
  }

  // Bump the line's received count.
  const newReceived = line.quantityReceived + n;
  const { error: uErr } = await supabase
    .from('purchase_order_lines')
    .update({ quantityReceived: newReceived })
    .eq('id', lineId);
  if (uErr) { const e = new Error(uErr.message); e.status = 500; throw e; }

  // If every line is now fully received (received >= ordered), flip PO.
  const { data: refreshed, error: rErr } = await supabase
    .from('purchase_order_lines')
    .select('"quantityOrdered","quantityReceived"')
    .eq('purchaseOrderId', id);
  if (rErr) { const e = new Error(rErr.message); e.status = 500; throw e; }
  const allDone = (refreshed || []).every(l => l.quantityReceived >= l.quantityOrdered);
  if (allDone) {
    await supabase
      .from('purchase_orders')
      .update({ status: 'received', receivedAt: nowIso, modifiedAt: nowIso, modifiedBy: user.displayName })
      .eq('id', id);
  }

  return res.status(200).json({
    line: { ...line, quantityReceived: newReceived },
    createdInventoryItemIds: createdIds,
    poFlippedToReceived: allDone,
  });
}
```

- [ ] **Step 3: Implement `cancelReceiveLine`**

Replace the placeholder `cancelReceiveLine` function with:

```js
async function cancelReceiveLine(req, res, user) {
  const { id, lineId } = req.body || {};
  const po = await loadPo(id);
  // Allow cancel on lines whose PO is either ordered (partial) or received.
  requireStatus(po, ['ordered', 'received']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }

  // Find every SKU originating from this line that's still 'available'.
  const { data: audits, error: aErr } = await supabase
    .from('purchase_order_received_items')
    .select('"inventoryItemId"')
    .eq('lineId', lineId);
  if (aErr) { const e = new Error(aErr.message); e.status = 500; throw e; }
  const itemIds = (audits || []).map(a => a.inventoryItemId);
  if (itemIds.length === 0) {
    return res.status(200).json({ deletedCount: 0, line: null });
  }

  const { data: items, error: iErr } = await supabase
    .from('inventory_items')
    .select('id, status, "deletedAt"')
    .in('id', itemIds);
  if (iErr) { const e = new Error(iErr.message); e.status = 500; throw e; }
  const cancelable = (items || []).filter(it => it.status === 'available' && !it.deletedAt);
  if (cancelable.length === 0) {
    const e = new Error('Nothing to cancel — every SKU from this line has already moved past available');
    e.status = 409; throw e;
  }

  // Soft-delete using the existing 30-day grace pattern.
  const nowIso = new Date().toISOString();
  const cancelIds = cancelable.map(c => c.id);
  const { error: dErr } = await supabase
    .from('inventory_items')
    .update({ deletedAt: nowIso, deletedBy: user.displayName })
    .in('id', cancelIds);
  if (dErr) { const e = new Error(dErr.message); e.status = 500; throw e; }

  // Decrement quantityReceived by the count we just cancelled.
  const { data: line } = await supabase
    .from('purchase_order_lines').select('*').eq('id', lineId).maybeSingle();
  if (line) {
    const next = Math.max(0, line.quantityReceived - cancelIds.length);
    await supabase
      .from('purchase_order_lines').update({ quantityReceived: next }).eq('id', lineId);
    line.quantityReceived = next;
  }

  // If PO was 'received', flip back to 'ordered'.
  if (po.status === 'received') {
    await supabase
      .from('purchase_orders')
      .update({ status: 'ordered', receivedAt: null, modifiedAt: nowIso, modifiedBy: user.displayName })
      .eq('id', id);
  }

  return res.status(200).json({ deletedCount: cancelIds.length, line });
}
```

- [ ] **Step 4: Manually verify the receive transaction**

```bash
# Reuse the ordered PO from Task 5 (or create + line + mark-ordered fresh).
# Receive 1 unit from a 2-unit line.
curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"receive-line\",\"id\":\"$PO\",\"lineId\":\"$LINE_ID\",\"quantityReceived\":1}" | jq .
```

Expected: `createdInventoryItemIds` is an array of length 1; `poFlippedToReceived: false` (because 1 of 2 remaining).

```bash
# Verify the SKU showed up in inventory.
curl -s "http://localhost:5173/api/items?userId=$USER_ID" \
  | jq ".items[] | select(.id==\"${createdInventoryItemIds[0]}\")"
```

Expected: `status: "available"`, `grossCost = unitWholesalePrice + perUnitShipping`, `idealPrice` matches species's idealSellingPrice (if set).

```bash
# Receive the remaining unit — PO should flip to received.
curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"receive-line\",\"id\":\"$PO\",\"lineId\":\"$LINE_ID\",\"quantityReceived\":1}" | jq .poFlippedToReceived
```

Expected: `true`.

```bash
# Cancel-receive — soft-delete the still-available SKUs.
curl -s -X POST http://localhost:5173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"action\":\"cancel-receive-line\",\"id\":\"$PO\",\"lineId\":\"$LINE_ID\"}" | jq .
```

Expected: `deletedCount: 2`. Verify with `GET /api/purchase-orders?action=get` that the PO is back to `status: "ordered"` and the line's `quantityReceived: 0`.

- [ ] **Step 5: Commit**

```bash
git add api/purchase-orders.js
git commit -m "api/purchase-orders: receive-line + cancel-receive-line (SKU gen + audit)"
```

---

## Task 7: Client API surface

**Files:**
- Modify: `src/api.js`

Extend the `api` export with `purchaseOrders.*` and `speciesPhotos.*` method groups. Also extend the existing `createSpecies` / `updateSpecies` calls to pass through the new catalog fields.

- [ ] **Step 1: Extend `createSpecies` and `updateSpecies`**

In `src/api.js`, find the existing species methods and replace them with:

```js
  // Species catalog
  getSpecies: () => request('/species').then(r => r.species),
  createSpecies: ({ varietyId, epithet, commonName, notes, imageUrl, wholesalePrice, idealSellingPrice }) =>
    request('/species', { method: 'POST', body: { varietyId, epithet, commonName, notes, imageUrl, wholesalePrice, idealSellingPrice } }).then(r => r.species),
  updateSpecies: ({ id, patch }) =>
    request('/species', { method: 'PATCH', body: { id, ...patch } }),
  deleteSpecies: (id) =>
    request('/species', { method: 'DELETE', body: { id } }),
```

- [ ] **Step 2: Append `purchaseOrders` + `speciesPhotos` method groups**

At the bottom of the `api` object (before the closing `};`), add:

```js
  // Purchase orders
  listPurchaseOrders: (statuses = 'draft,ordered') =>
    request(`/purchase-orders?status=${encodeURIComponent(statuses)}`).then(r => r.purchaseOrders),
  getPurchaseOrder: (id) =>
    request(`/purchase-orders?action=get&id=${encodeURIComponent(id)}`).then(r => ({
      purchaseOrder: r.purchaseOrder, lines: r.lines, receivedItems: r.receivedItems,
    })),
  createPurchaseOrder: ({ supplier, shippingFee, notes } = {}) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'create', supplier, shippingFee, notes } }).then(r => r.purchaseOrder),
  updatePurchaseOrderHeader: ({ id, supplier, shippingFee, notes }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'update-header', id, supplier, shippingFee, notes } }).then(r => r.purchaseOrder),
  addPurchaseOrderLine: ({ id, speciesId, quantityOrdered, unitWholesalePrice }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'add-line', id, speciesId, quantityOrdered, unitWholesalePrice } }).then(r => r.line),
  updatePurchaseOrderLine: ({ id, lineId, quantityOrdered, unitWholesalePrice }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'update-line', id, lineId, quantityOrdered, unitWholesalePrice } }),
  removePurchaseOrderLine: ({ id, lineId }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'remove-line', id, lineId } }),
  markPurchaseOrderOrdered: (id) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'mark-ordered', id } }).then(r => r.purchaseOrder),
  receivePurchaseOrderLine: ({ id, lineId, quantityReceived }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'receive-line', id, lineId, quantityReceived } }),
  cancelReceivePurchaseOrderLine: ({ id, lineId }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'cancel-receive-line', id, lineId } }),
  deletePurchaseOrder: (id) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'delete', id } }),

  // Species photos
  uploadSpeciesPhoto: ({ speciesId, fileBase64, contentType, filename }) =>
    request('/species-photos', { method: 'POST', body: { action: 'upload', speciesId, fileBase64, contentType, filename } }),
  deleteSpeciesPhoto: (id) =>
    request('/species-photos', { method: 'POST', body: { action: 'delete', id } }),
  reorderSpeciesPhotos: ({ speciesId, orderedPhotoIds }) =>
    request('/species-photos', { method: 'POST', body: { action: 'reorder', speciesId, orderedPhotoIds } }),
  speciesPhotoSignedUrl: (id) =>
    request(`/species-photos?action=signed-url&id=${encodeURIComponent(id)}`).then(r => r.url),
```

- [ ] **Step 3: Manually verify in browser console**

Open the app, log in, open DevTools console:

```js
await (await fetch('/api/purchase-orders?status=draft&userId=' + JSON.parse(localStorage['session-current-user']).id)).json()
```

Expected: `{ purchaseOrders: [...] }` — the same response shape the client methods will receive.

- [ ] **Step 4: Commit**

```bash
git add src/api.js
git commit -m "api(client): add purchaseOrders.* and speciesPhotos.* methods"
```

---

## Task 8: UI — `PurchasingView` shell + swap into `App.jsx`

**Files:**
- Create: `src/purchasing/PurchasingView.jsx`
- Modify: `src/App.jsx` (swap the lazy import path + props passed)

This task gives you a working tab with two empty sub-tab panes. Subsequent tasks fill the panes.

- [ ] **Step 1: Create `PurchasingView.jsx` with sub-tab routing**

Create `src/purchasing/PurchasingView.jsx`:

```jsx
import { useState } from 'react';
import { ShoppingCart, Package } from 'lucide-react';
import { CatalogPane } from './CatalogPane.jsx';
import { OrdersPane } from './OrdersPane.jsx';

// Two-sub-tab shell: Catalog | Orders. State of which sub-tab is open
// lives here so switching back to the Purchase tab from another top-level
// tab restores the last sub-tab the operator used. State of the "current
// draft PO" is owned by OrdersPane (server-derived from the most-recent
// draft); CatalogPane queries the server when it needs to read it.

export function PurchasingView({ varieties, species, items, currentUser, showToast, setConfirmDialog, onSpeciesChanged, onItemsChanged }) {
  const [sub, setSub] = useState('catalog');
  return (
    <div className="space-y-4 pb-32">
      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5">
        {[
          { id: 'catalog', label: 'Catalog', icon: ShoppingCart },
          { id: 'orders',  label: 'Orders',  icon: Package },
        ].map(t => {
          const active = sub === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setSub(t.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg transition ${
                active ? 'bg-emerald-600 text-white font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {sub === 'catalog' && (
        <CatalogPane
          varieties={varieties}
          species={species}
          currentUser={currentUser}
          showToast={showToast}
          onSpeciesChanged={onSpeciesChanged}
        />
      )}
      {sub === 'orders' && (
        <OrdersPane
          varieties={varieties}
          species={species}
          currentUser={currentUser}
          showToast={showToast}
          setConfirmDialog={setConfirmDialog}
          onItemsChanged={onItemsChanged}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create temporary stub files for `CatalogPane` and `OrdersPane`**

These get fleshed out in later tasks; for now they let `PurchasingView` render without errors.

Create `src/purchasing/CatalogPane.jsx`:

```jsx
export function CatalogPane() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
      Catalog pane — implemented in Task 9.
    </div>
  );
}
```

Create `src/purchasing/OrdersPane.jsx`:

```jsx
export function OrdersPane() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
      Orders pane — implemented in Task 12.
    </div>
  );
}
```

- [ ] **Step 3: Swap the lazy import in `App.jsx`**

In `src/App.jsx`, line 27, change:

```js
const PurchaseOrderView = lazyNamed(() => import('./purchasing/PurchaseOrderView.jsx'), 'PurchaseOrderView');
```

to:

```js
const PurchasingView = lazyNamed(() => import('./purchasing/PurchasingView.jsx'), 'PurchasingView');
```

In `src/App.jsx`, find the `activeTab === 'purchasing'` block (around line 1048) and replace it with:

```jsx
        {activeTab === 'purchasing' && (
          <PurchasingView
            varieties={varieties}
            species={species}
            items={items}
            currentUser={currentUser}
            showToast={showToast}
            setConfirmDialog={setConfirmDialog}
            onSpeciesChanged={async () => {
              const fresh = await api.getSpecies();
              setSpecies(fresh);
            }}
            onItemsChanged={async () => {
              const fresh = await api.getItems();
              applyItemsFresh(fresh);
            }}
          />
        )}
```

(If `currentUser`, `setConfirmDialog`, or `applyItemsFresh` have different names in the local scope of `App.jsx`, use the existing names — they're all referenced elsewhere in the file.)

- [ ] **Step 4: Manually verify the tab renders**

Run `npm run dev`. Open the app → click the **Purchase** tab. Expected: two sub-tab buttons (Catalog, Orders) and the corresponding stub message ("Catalog pane — implemented in Task 9") swaps when you click between them.

- [ ] **Step 5: Commit**

```bash
git add src/purchasing/PurchasingView.jsx src/purchasing/CatalogPane.jsx src/purchasing/OrdersPane.jsx src/App.jsx
git commit -m "purchasing: shell with Catalog/Orders sub-tabs; swap App.jsx lazy import"
```

---

## Task 9: UI — Catalog read-only grid + cards

**Files:**
- Create: `src/purchasing/CatalogPlantCard.jsx`
- Modify: `src/purchasing/CatalogPane.jsx` (replace stub with real grid)

Top bar with filter + search + sort, grid of cards. Cards are display-only in this task — clicking does nothing yet. The edit modal lands in Task 10, photos in Task 11.

- [ ] **Step 1: Create `CatalogPlantCard.jsx`**

```jsx
import { ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Read-only card. The "+ Add to draft" wiring lands in Task 12.
// Photo display: fetches a signed URL on mount for the primary photo
// (or the first by sortOrder if no primary set, or falls back to the
// legacy species.imageUrl).
export function CatalogPlantCard({ plant, onOpenDetail }) {
  const primaryPhoto = (() => {
    if (!plant.photos || plant.photos.length === 0) return null;
    if (plant.primaryPhotoId) {
      const m = plant.photos.find(p => p.id === plant.primaryPhotoId);
      if (m) return m;
    }
    return plant.photos[0];
  })();

  const [imgUrl, setImgUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    if (primaryPhoto) {
      api.speciesPhotoSignedUrl(primaryPhoto.id)
        .then(url => { if (alive) setImgUrl(url); })
        .catch(() => {});
    } else if (plant.imageUrl) {
      setImgUrl(plant.imageUrl);
    } else {
      setImgUrl(null);
    }
    return () => { alive = false; };
  }, [primaryPhoto?.id, plant.imageUrl]);

  const ws = plant.wholesalePrice;
  const ideal = plant.idealSellingPrice;
  const margin = (Number.isFinite(ws) && ws > 0 && Number.isFinite(ideal))
    ? ((ideal - ws) / ws) * 100
    : null;

  return (
    <button
      type="button"
      onClick={onOpenDetail}
      className="bg-white rounded-xl border border-gray-200 hover:border-emerald-400 text-left overflow-hidden transition flex flex-col"
    >
      <div className="aspect-square bg-gray-100 flex items-center justify-center text-gray-300">
        {imgUrl
          ? <img src={imgUrl} alt={plant.epithet} className="w-full h-full object-cover" />
          : <ImageOff className="w-8 h-8" />}
      </div>
      <div className="p-3 space-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium truncate">
            {plant.varietyName || ''}
          </div>
          <div className="font-semibold text-sm text-gray-900 leading-tight truncate">
            {plant.epithet}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1 text-[11px]">
          <Stat label="Wholesale" value={fmt$(ws)} />
          <Stat label="Ideal"     value={fmt$(ideal)} />
          <Stat label="Margin"    value={margin != null ? `${margin.toFixed(0)}%` : '—'} />
        </div>
      </div>
    </button>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="font-semibold text-gray-900 tabular-nums">{value}</div>
    </div>
  );
}

function fmt$(n) {
  if (n == null || !Number.isFinite(parseFloat(n))) return '—';
  return `$${parseFloat(n).toFixed(2)}`;
}
```

- [ ] **Step 2: Replace `CatalogPane.jsx` with the real grid + filters**

```jsx
import { useMemo, useState } from 'react';
import { Search, Plus } from 'lucide-react';
import { CatalogPlantCard } from './CatalogPlantCard.jsx';

const SORTS = [
  { id: 'name',       label: 'Name' },
  { id: 'wholesale',  label: 'Wholesale ↑' },
  { id: 'ideal',      label: 'Ideal ↑' },
  { id: 'margin',     label: 'Margin ↓' },
  { id: 'recent',     label: 'Recently added' },
];

export function CatalogPane({ varieties, species, currentUser, showToast, onSpeciesChanged }) {
  const [varietyTab, setVarietyTab] = useState('all');
  const [search, setSearch] = useState('');
  const [sortId, setSortId] = useState('name');
  // PlantDetailModal wired in Task 10; selectedSpeciesId=null until then.
  const [, setSelectedSpeciesId] = useState(null);

  // Decorate each species row with its variety name (the API only
  // returns varietyId).
  const varietyById = useMemo(() => {
    const m = new Map();
    for (const v of varieties || []) m.set(v.id, v);
    return m;
  }, [varieties]);

  const plants = useMemo(
    () => (species || []).map(s => ({ ...s, varietyName: varietyById.get(s.varietyId)?.name || '' })),
    [species, varietyById],
  );

  const filtered = useMemo(() => {
    let s = plants;
    if (varietyTab !== 'all') s = s.filter(p => p.varietyId === varietyTab);
    if (search) {
      const q = search.toLowerCase();
      s = s.filter(p =>
        (p.epithet || '').toLowerCase().includes(q) ||
        (p.commonName || '').toLowerCase().includes(q) ||
        (p.varietyName || '').toLowerCase().includes(q)
      );
    }
    const copy = [...s];
    switch (sortId) {
      case 'wholesale': copy.sort((a, b) => (a.wholesalePrice ?? Infinity)    - (b.wholesalePrice ?? Infinity));    break;
      case 'ideal':     copy.sort((a, b) => (a.idealSellingPrice ?? Infinity) - (b.idealSellingPrice ?? Infinity)); break;
      case 'margin': {
        const m = (p) => (Number.isFinite(p.wholesalePrice) && p.wholesalePrice > 0 && Number.isFinite(p.idealSellingPrice))
          ? (p.idealSellingPrice - p.wholesalePrice) / p.wholesalePrice
          : -Infinity;
        copy.sort((a, b) => m(b) - m(a));
        break;
      }
      case 'recent':    copy.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); break;
      case 'name':
      default:          copy.sort((a, b) => a.epithet.localeCompare(b.epithet)); break;
    }
    return copy;
  }, [plants, varietyTab, search, sortId]);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plant or variety..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </div>
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg overflow-x-auto">
            {SORTS.map(s => (
              <button
                key={s.id}
                onClick={() => setSortId(s.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition ${
                  sortId === s.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 active:bg-gray-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSelectedSpeciesId('NEW')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg"
          >
            <Plus className="w-4 h-4" /> New plant
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5 overflow-x-auto">
        {[{ id: 'all', name: 'All' }, ...(varieties || [])].map(v => {
          const active = varietyTab === v.id;
          const count = v.id === 'all' ? plants.length : plants.filter(p => p.varietyId === v.id).length;
          return (
            <button
              key={v.id}
              onClick={() => setVarietyTab(v.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition whitespace-nowrap ${
                active ? 'bg-emerald-600 text-white font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {v.name}
              <span className={`text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
          No plants match.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map(plant => (
            <CatalogPlantCard
              key={plant.id}
              plant={plant}
              onOpenDetail={() => setSelectedSpeciesId(plant.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Manually verify the grid renders**

Open the **Purchase** tab → **Catalog**. Expected:
- Search bar, sort pills, "New plant" button, variety filter tabs.
- A card per species. Each card shows variety + epithet + Wholesale / Ideal / Margin (mostly "—" since prices aren't set yet).
- Cards with the legacy `imageUrl` field set show their photo. Cards with no photo show the placeholder icon.
- Sort and search both work without crashing.

- [ ] **Step 4: Commit**

```bash
git add src/purchasing/CatalogPane.jsx src/purchasing/CatalogPlantCard.jsx
git commit -m "purchasing: catalog grid with filter/search/sort + plant cards"
```

---

## Task 10: UI — `PlantDetailModal` (catalog edit, no photos yet)

**Files:**
- Create: `src/purchasing/PlantDetailModal.jsx`
- Modify: `src/purchasing/CatalogPane.jsx` (wire the modal in)

Editable fields: variety, epithet, common name, wholesale price, ideal selling price, profit rate, notes. Photos are added in Task 11.

- [ ] **Step 1: Create the modal**

Create `src/purchasing/PlantDetailModal.jsx`:

```jsx
import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { api } from '../api.js';

// Edit (or create) a catalog plant. `initial` is null for create mode;
// in create mode the variety field is required and the API runs the
// POST path. PhotoGallery is added in Task 11 — for now the photos
// strip is omitted.
//
// onSaved(species) → called with the updated/created species row so
// the parent can refresh its cache.

export function PlantDetailModal({ initial, varieties, onClose, onSaved, showToast }) {
  const isCreate = !initial;
  const [varietyId, setVarietyId] = useState(initial?.varietyId || (varieties?.[0]?.id || ''));
  const [epithet, setEpithet] = useState(initial?.epithet || '');
  const [commonName, setCommonName] = useState(initial?.commonName || '');
  const [wholesalePrice, setWholesalePrice] = useState(
    initial?.wholesalePrice != null ? String(initial.wholesalePrice) : ''
  );
  const [idealSellingPrice, setIdealSellingPrice] = useState(
    initial?.idealSellingPrice != null ? String(initial.idealSellingPrice) : ''
  );
  const [profitRate, setProfitRate] = useState(
    initial?.profitRate != null ? String(initial.profitRate) : ''
  );
  const [notes, setNotes] = useState(initial?.notes || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    if (!varietyId) { setErr('Variety required'); return; }
    if (!epithet.trim()) { setErr('Name required'); return; }
    setSaving(true);
    try {
      const body = {
        varietyId,
        epithet: epithet.trim(),
        commonName: commonName.trim() || null,
        wholesalePrice: wholesalePrice === '' ? null : parseFloat(wholesalePrice),
        idealSellingPrice: idealSellingPrice === '' ? null : parseFloat(idealSellingPrice),
        notes: notes || null,
      };
      let saved;
      if (isCreate) {
        saved = await api.createSpecies(body);
      } else {
        // Profit rate only goes on the patch path; create handler doesn't take it yet.
        await api.updateSpecies({
          id: initial.id,
          patch: {
            ...body,
            profitRate: profitRate === '' ? null : parseFloat(profitRate),
          },
        });
        saved = { ...initial, ...body, profitRate: profitRate === '' ? null : parseFloat(profitRate) };
      }
      onSaved?.(saved);
      showToast?.(isCreate ? 'Plant created' : 'Saved', 2000);
      onClose();
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold">{isCreate ? 'New plant' : 'Edit plant'}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-gray-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <Field label="Variety">
            <select
              value={varietyId}
              onChange={(e) => setVarietyId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
            >
              {(varieties || []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
          <Field label="Name / epithet">
            <input value={epithet} onChange={(e) => setEpithet(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </Field>
          <Field label="Common name">
            <input value={commonName} onChange={(e) => setCommonName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Wholesale ($)">
              <input type="number" step="0.01" value={wholesalePrice}
                onChange={(e) => setWholesalePrice(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
            </Field>
            <Field label="Ideal sell ($)">
              <input type="number" step="0.01" value={idealSellingPrice}
                onChange={(e) => setIdealSellingPrice(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
            </Field>
          </div>
          {!isCreate && (
            <Field label="Profit rate (%)">
              <input type="number" step="0.1" value={profitRate}
                onChange={(e) => setProfitRate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
            </Field>
          )}
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-y" />
          </Field>
          {err && <div className="text-sm text-red-600">{err}</div>}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}
```

- [ ] **Step 2: Wire the modal into `CatalogPane.jsx`**

In `src/purchasing/CatalogPane.jsx`, replace the import block and the destructuring of `setSelectedSpeciesId` with a usable state pair, and render the modal:

At the top, add:

```jsx
import { PlantDetailModal } from './PlantDetailModal.jsx';
```

Replace the line `const [, setSelectedSpeciesId] = useState(null);` with:

```jsx
  const [selectedSpeciesId, setSelectedSpeciesId] = useState(null);
```

At the bottom of the returned JSX (just before the closing `</div>`), add:

```jsx
      {selectedSpeciesId && (
        <PlantDetailModal
          initial={selectedSpeciesId === 'NEW' ? null : plants.find(p => p.id === selectedSpeciesId)}
          varieties={varieties}
          showToast={showToast}
          onClose={() => setSelectedSpeciesId(null)}
          onSaved={() => onSpeciesChanged?.()}
        />
      )}
```

- [ ] **Step 3: Manually verify**

Run `npm run dev` → Purchase → Catalog:
1. Click a card → modal opens prefilled with that plant's fields.
2. Enter a wholesale price (e.g., 12.50) and ideal sell price (e.g., 45.00). Save. Modal closes, toast appears. Reopen the card — values persist. The card now shows Wholesale `$12.50`, Ideal `$45.00`, Margin `260%`.
3. Click "+ New plant" → modal opens in create mode. Pick a variety, type an epithet, set prices, Save. New card appears in the grid.

- [ ] **Step 4: Commit**

```bash
git add src/purchasing/PlantDetailModal.jsx src/purchasing/CatalogPane.jsx
git commit -m "purchasing: plant detail modal (catalog create/edit with prices)"
```

---

## Task 11: UI — `PhotoGallery` (upload, set primary, delete, reorder)

**Files:**
- Create: `src/purchasing/PhotoGallery.jsx`
- Modify: `src/purchasing/PlantDetailModal.jsx` (mount the gallery inside)

Edit-mode only (create-mode doesn't have a species id yet). Drag-reorder uses native HTML5 drag events — no library.

- [ ] **Step 1: Create the `PhotoGallery` component**

Create `src/purchasing/PhotoGallery.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import { Upload, Star, X, Loader2, ImagePlus } from 'lucide-react';
import { api } from '../api.js';

// Photo CRUD widget for a single species. Caller passes the parent
// species (so we can show + edit primaryPhotoId), and onPhotosChanged
// after any mutation so the parent can refresh.
//
// Display: signed URLs cached locally for the modal session — each
// photo refetches its URL on mount, then reuses. (Signed URLs are
// 5 minutes; we never live long enough in this modal to hit expiry.)

export function PhotoGallery({ speciesId, photos, primaryPhotoId, onChanged, showToast }) {
  const [busy, setBusy] = useState(false);
  const [urls, setUrls] = useState({}); // photoId → signed URL
  const [draggingId, setDraggingId] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const next = { ...urls };
      let mutated = false;
      for (const ph of photos) {
        if (next[ph.id]) continue;
        try {
          next[ph.id] = await api.speciesPhotoSignedUrl(ph.id);
          mutated = true;
        } catch { /* skip */ }
      }
      if (alive && mutated) setUrls(next);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.map(p => p.id).join(',')]);

  const handleUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const b64 = await fileToBase64(file);
      const { photo, signedUrl } = await api.uploadSpeciesPhoto({
        speciesId,
        fileBase64: b64,
        contentType: file.type || 'image/jpeg',
        filename: file.name,
      });
      if (signedUrl) setUrls(u => ({ ...u, [photo.id]: signedUrl }));
      onChanged?.();
      showToast?.('Photo uploaded', 1800);
    } catch (e) {
      showToast?.(e.message || 'Upload failed', 3000);
    } finally {
      setBusy(false);
    }
  };

  const setPrimary = async (id) => {
    setBusy(true);
    try {
      await api.updateSpecies({ id: speciesId, patch: { primaryPhotoId: id } });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Set primary failed', 3000);
    } finally { setBusy(false); }
  };

  const remove = async (id) => {
    setBusy(true);
    try {
      await api.deleteSpeciesPhoto(id);
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Delete failed', 3000);
    } finally { setBusy(false); }
  };

  const reorderTo = async (dropTargetId) => {
    if (!draggingId || draggingId === dropTargetId) return;
    const ordered = [...photos];
    const fromIdx = ordered.findIndex(p => p.id === draggingId);
    const toIdx   = ordered.findIndex(p => p.id === dropTargetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = ordered.splice(fromIdx, 1);
    ordered.splice(toIdx, 0, moved);
    setDraggingId(null);
    setBusy(true);
    try {
      await api.reorderSpeciesPhotos({ speciesId, orderedPhotoIds: ordered.map(p => p.id) });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Reorder failed', 3000);
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleUpload(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Upload photo
        </button>
        <div className="text-xs text-gray-500">Drag to reorder · click ★ to set primary</div>
      </div>

      {photos.length === 0 ? (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-lg p-6 text-center text-sm text-gray-500">
          <ImagePlus className="w-6 h-6 mx-auto mb-1 text-gray-400" />
          No photos yet.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {photos.map(ph => {
            const isPrimary = primaryPhotoId === ph.id || (!primaryPhotoId && ph === photos[0]);
            return (
              <div
                key={ph.id}
                draggable
                onDragStart={() => setDraggingId(ph.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => reorderTo(ph.id)}
                className={`relative aspect-square rounded-lg overflow-hidden border-2 ${
                  isPrimary ? 'border-emerald-500' : 'border-gray-200'
                } ${draggingId === ph.id ? 'opacity-50' : ''}`}
              >
                {urls[ph.id]
                  ? <img src={urls[ph.id]} alt="" className="w-full h-full object-cover" draggable={false} />
                  : <div className="w-full h-full bg-gray-100 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
                    </div>}
                <button
                  type="button"
                  onClick={() => setPrimary(ph.id)}
                  disabled={busy || isPrimary}
                  title={isPrimary ? 'Primary photo' : 'Make primary'}
                  className={`absolute top-1 left-1 p-1 rounded-full bg-white/90 hover:bg-white ${isPrimary ? 'text-emerald-600' : 'text-gray-400'}`}
                >
                  <Star className="w-3.5 h-3.5" fill={isPrimary ? 'currentColor' : 'none'} />
                </button>
                <button
                  type="button"
                  onClick={() => remove(ph.id)}
                  disabled={busy}
                  className="absolute top-1 right-1 p-1 rounded-full bg-white/90 hover:bg-red-50 text-red-600"
                  title="Delete"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload  = () => {
      const r = String(reader.result || '');
      const comma = r.indexOf(',');
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.readAsDataURL(file);
  });
}
```

- [ ] **Step 2: Mount `PhotoGallery` in `PlantDetailModal`**

In `src/purchasing/PlantDetailModal.jsx`, add to the imports:

```jsx
import { PhotoGallery } from './PhotoGallery.jsx';
```

In the modal body (inside the `<div className="px-5 py-4 space-y-3">` block, just below the Variety field), add:

```jsx
          {!isCreate && (
            <Field label="Photos">
              <PhotoGallery
                speciesId={initial.id}
                photos={initial.photos || []}
                primaryPhotoId={initial.primaryPhotoId}
                onChanged={() => onSaved?.(initial)}
                showToast={showToast}
              />
            </Field>
          )}
```

(In create mode the species doesn't exist yet, so the gallery is hidden — the operator has to save the plant first to get an id, then re-open it to add photos.)

- [ ] **Step 3: Manually verify**

1. Open any catalog plant → upload a photo (JPEG/PNG). Spinner shows briefly, then the thumbnail appears.
2. Upload 2 more — they appear in upload order.
3. Drag the third to the first slot — order updates, persists across modal close/reopen.
4. Click the star on the second-position photo — green border moves to it; closing the modal and looking at the card grid, that photo is now the card's main image.
5. Delete the primary — the green border falls back to whichever photo is now first.

- [ ] **Step 4: Commit**

```bash
git add src/purchasing/PhotoGallery.jsx src/purchasing/PlantDetailModal.jsx
git commit -m "purchasing: photo gallery (upload, reorder, set primary, delete)"
```

---

## Task 12: UI — `OrdersPane` list view + "+ Add to draft" from catalog

**Files:**
- Create: `src/purchasing/PurchaseOrderCard.jsx`
- Modify: `src/purchasing/OrdersPane.jsx` (replace stub with real list)
- Modify: `src/purchasing/CatalogPlantCard.jsx` (add the button)
- Modify: `src/purchasing/CatalogPane.jsx` (pass currentDraft + onAdd callback)

`PurchaseOrderCard` is also a placeholder for the expanded detail (Task 13). This task only renders the collapsed row.

- [ ] **Step 1: Create `PurchaseOrderCard.jsx` (collapsed-only for now)**

Create `src/purchasing/PurchaseOrderCard.jsx`:

```jsx
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

// Inline-expandable PO card. Task 13 fills in the expanded detail.
// Status dot color: gray=draft, amber=ordered, emerald=received.

const STATUS_CLASS = {
  draft:    'bg-gray-300',
  ordered:  'bg-amber-500',
  received: 'bg-emerald-500',
};

export function PurchaseOrderCard({ po }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50"
      >
        <div className="mt-0.5 text-gray-400">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block w-2 h-2 rounded-full ${STATUS_CLASS[po.status] || 'bg-gray-300'}`} />
            <span className="font-medium text-gray-900 capitalize">{po.status}</span>
            <span className="text-gray-500">·</span>
            <span className="text-gray-700">{new Date(po.createdAt).toISOString().slice(0, 10)}</span>
            {po.supplier && (
              <>
                <span className="text-gray-500">·</span>
                <span className="text-gray-700 truncate">{po.supplier}</span>
              </>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {po.lineCount} {po.lineCount === 1 ? 'line' : 'lines'}
            {' · '}
            {po.unitCount} {po.unitCount === 1 ? 'unit' : 'units'}
            {po.shippingFee > 0 && ` + $${parseFloat(po.shippingFee).toFixed(2)} ship`}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 py-3 text-sm text-gray-500">
          Detail panel — implemented in Task 13.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace `OrdersPane.jsx` with the real list view**

```jsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { PurchaseOrderCard } from './PurchaseOrderCard.jsx';

const FILTERS = [
  { id: 'draft',    label: 'Draft' },
  { id: 'ordered',  label: 'Ordered' },
  { id: 'received', label: 'Received' },
];

export function OrdersPane({ species, currentUser, showToast }) {
  const [activeFilters, setActiveFilters] = useState(new Set(['draft', 'ordered']));
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    setErr('');
    try {
      const statuses = [...activeFilters].join(',') || 'draft,ordered';
      const fresh = await api.listPurchaseOrders(statuses);
      setPos(fresh);
    } catch (e) {
      setErr(e.message || 'Load failed');
    }
  }, [activeFilters]);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const toggleFilter = (id) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      // Don't allow zero filters (would be empty for no good reason).
      if (next.size === 0) return prev;
      return next;
    });
  };

  const createNew = async () => {
    try {
      const po = await api.createPurchaseOrder({});
      showToast?.('Draft created', 1500);
      // Move filter to include draft (in case it was hidden) and refresh.
      setActiveFilters(prev => prev.has('draft') ? prev : new Set([...prev, 'draft']));
      setPos(prev => [{ ...po, lineCount: 0, unitCount: 0 }, ...prev]);
    } catch (e) {
      showToast?.(e.message || 'Create failed', 3000);
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
          {FILTERS.map(f => {
            const active = activeFilters.has(f.id);
            return (
              <button
                key={f.id}
                onClick={() => toggleFilter(f.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={createNew}
          className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg"
        >
          <Plus className="w-4 h-4" /> New PO
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      ) : err ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {err} <button onClick={refresh} className="underline ml-2">retry</button>
        </div>
      ) : pos.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
          No purchase orders match these filters.
        </div>
      ) : (
        <div className="space-y-2">
          {pos.map(po => (
            <PurchaseOrderCard key={po.id} po={po} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add "+ Add to draft" to `CatalogPlantCard.jsx`**

Update `CatalogPlantCard.jsx` to accept and render an `onAddToDraft` prop:

In the function signature:

```jsx
export function CatalogPlantCard({ plant, onOpenDetail, onAddToDraft, adding }) {
```

Inside the card body, replace the wrapping `<button>` with a `<div>` and put the click-to-open + the "+ Add" button as separate elements (so the button doesn't trigger card open). Replace the entire return value:

```jsx
  return (
    <div className="bg-white rounded-xl border border-gray-200 hover:border-emerald-400 overflow-hidden transition flex flex-col">
      <button
        type="button"
        onClick={onOpenDetail}
        className="block text-left"
      >
        <div className="aspect-square bg-gray-100 flex items-center justify-center text-gray-300">
          {imgUrl
            ? <img src={imgUrl} alt={plant.epithet} className="w-full h-full object-cover" />
            : <ImageOff className="w-8 h-8" />}
        </div>
        <div className="p-3 space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium truncate">
              {plant.varietyName || ''}
            </div>
            <div className="font-semibold text-sm text-gray-900 leading-tight truncate">
              {plant.epithet}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 text-[11px]">
            <Stat label="Wholesale" value={fmt$(ws)} />
            <Stat label="Ideal"     value={fmt$(ideal)} />
            <Stat label="Margin"    value={margin != null ? `${margin.toFixed(0)}%` : '—'} />
          </div>
        </div>
      </button>
      {onAddToDraft && (
        <button
          type="button"
          onClick={onAddToDraft}
          disabled={adding}
          className="m-2 mt-0 flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium border border-emerald-300 text-emerald-700 hover:bg-emerald-50 rounded-md disabled:opacity-60"
        >
          + Add to draft
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire `onAddToDraft` in `CatalogPane.jsx`**

In `CatalogPane.jsx`, add to imports:

```jsx
import { api } from '../api.js';
```

Inside the component body (after `const [selectedSpeciesId, setSelectedSpeciesId] = useState(null);`), add:

```jsx
  const [addingId, setAddingId] = useState(null);

  const addToDraft = async (plant) => {
    setAddingId(plant.id);
    try {
      // Find or create a draft PO. List all drafts, pick the most recent.
      const drafts = await api.listPurchaseOrders('draft');
      let po = drafts && drafts[0];
      if (!po) {
        po = await api.createPurchaseOrder({});
      }
      await api.addPurchaseOrderLine({
        id: po.id,
        speciesId: plant.id,
        quantityOrdered: 1,
      });
      showToast?.(`Added ${plant.epithet} to draft`, 1500);
    } catch (e) {
      showToast?.(e.message || 'Add failed', 3000);
    } finally {
      setAddingId(null);
    }
  };
```

In the JSX, change the card render to pass the new props:

```jsx
          {filtered.map(plant => (
            <CatalogPlantCard
              key={plant.id}
              plant={plant}
              onOpenDetail={() => setSelectedSpeciesId(plant.id)}
              onAddToDraft={() => addToDraft(plant)}
              adding={addingId === plant.id}
            />
          ))}
```

- [ ] **Step 5: Manually verify**

1. Purchase → Orders → click **+ New PO**. Empty draft row appears.
2. Switch to Catalog → click "+ Add to draft" on a plant. Toast confirms. Switch back to Orders → the existing draft now shows `1 line · 1 unit`.
3. Click "+ Add to draft" on the same plant again → unit count goes to 2 (no second line). On a different plant → line count goes to 2.
4. Click each filter pill — list narrows accordingly. Disabling the last pill is prevented.

- [ ] **Step 6: Commit**

```bash
git add src/purchasing/OrdersPane.jsx src/purchasing/PurchaseOrderCard.jsx src/purchasing/CatalogPane.jsx src/purchasing/CatalogPlantCard.jsx
git commit -m "purchasing: orders list, draft creation, + Add to draft from catalog"
```

---

## Task 13: UI — Expanded PO detail + line editing (draft state)

**Files:**
- Create: `src/purchasing/PurchaseOrderLineRow.jsx`
- Modify: `src/purchasing/PurchaseOrderCard.jsx` (fill in the expanded section)

This task handles editing lines while the PO is still `draft`: change qty, change price, remove line. Mark-ordered / receive happens in Task 14.

- [ ] **Step 1: Create `PurchaseOrderLineRow.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import { api } from '../api.js';

// One line in an expanded PO. Editing rules:
//   - poStatus = draft    → quantityOrdered + unitWholesalePrice editable; remove allowed
//   - poStatus = ordered  → quantityReceived input + Receive button (Task 14)
//   - poStatus = received → fully read-only (Task 14)
//
// `species` is the catalog row this line points to; we render the photo +
// name from it. Caller provides showToast + onChanged (refetch parent).

export function PurchaseOrderLineRow({ line, species, poStatus, poId, showToast, onChanged }) {
  const [qty, setQty]     = useState(String(line.quantityOrdered));
  const [price, setPrice] = useState(String(line.unitWholesalePrice));
  const [busy, setBusy]   = useState(false);
  const [photoUrl, setPhotoUrl] = useState(null);

  useEffect(() => { setQty(String(line.quantityOrdered)); }, [line.quantityOrdered]);
  useEffect(() => { setPrice(String(line.unitWholesalePrice)); }, [line.unitWholesalePrice]);

  // Resolve a thumbnail signed URL.
  useEffect(() => {
    let alive = true;
    const ph = (species?.photos || []).find(p => p.id === species?.primaryPhotoId)
      || (species?.photos || [])[0];
    if (ph) {
      api.speciesPhotoSignedUrl(ph.id).then(url => { if (alive) setPhotoUrl(url); }).catch(() => {});
    } else if (species?.imageUrl) {
      setPhotoUrl(species.imageUrl);
    } else {
      setPhotoUrl(null);
    }
    return () => { alive = false; };
  }, [species?.id]);

  const saveQty = async () => {
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setQty(String(line.quantityOrdered));
      return;
    }
    if (n === line.quantityOrdered) return;
    setBusy(true);
    try {
      await api.updatePurchaseOrderLine({ id: poId, lineId: line.id, quantityOrdered: n });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Update failed', 3000);
      setQty(String(line.quantityOrdered));
    } finally { setBusy(false); }
  };

  const savePrice = async () => {
    const n = parseFloat(price);
    if (!Number.isFinite(n) || n < 0) {
      setPrice(String(line.unitWholesalePrice));
      return;
    }
    if (n === Number(line.unitWholesalePrice)) return;
    setBusy(true);
    try {
      await api.updatePurchaseOrderLine({ id: poId, lineId: line.id, unitWholesalePrice: n });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Update failed', 3000);
      setPrice(String(line.unitWholesalePrice));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.removePurchaseOrderLine({ id: poId, lineId: line.id });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Remove failed', 3000);
    } finally { setBusy(false); }
  };

  const lineTotal = (Number(price) || 0) * (parseInt(qty, 10) || 0);
  const isDraft = poStatus === 'draft';

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 border-t border-gray-100">
      <div className="w-14 h-14 bg-gray-100 rounded shrink-0 overflow-hidden flex items-center justify-center text-gray-300">
        {photoUrl ? <img src={photoUrl} alt="" className="w-full h-full object-cover" /> : '—'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-900 truncate">
          {species?.varietyName || ''} · {species?.epithet || '(unknown)'}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs flex-wrap">
          <span className="text-gray-500">Ordered</span>
          {isDraft ? (
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onBlur={saveQty}
              className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
            />
          ) : (
            <span className="font-semibold text-gray-900">{line.quantityOrdered}</span>
          )}
          <span className="text-gray-500">@ $</span>
          {isDraft ? (
            <input
              type="number"
              step="0.01"
              min={0}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onBlur={savePrice}
              className="w-20 px-2 py-1 text-xs border border-gray-300 rounded"
            />
          ) : (
            <span className="font-semibold text-gray-900">${Number(line.unitWholesalePrice).toFixed(2)}</span>
          )}
          <span className="text-gray-500">=</span>
          <span className="font-semibold text-gray-900 tabular-nums">${lineTotal.toFixed(2)}</span>
          {!isDraft && (
            <span className="ml-auto text-gray-500">
              Received {line.quantityReceived}/{line.quantityOrdered}
            </span>
          )}
        </div>
      </div>
      {isDraft && (
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="shrink-0 p-1.5 text-gray-400 hover:text-red-600 rounded"
          title="Remove line"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Replace the placeholder detail in `PurchaseOrderCard.jsx`**

Update `PurchaseOrderCard.jsx` to load lines on expand, render them via `PurchaseOrderLineRow`, and expose header editing + a Delete-PO button while draft.

Replace the file with:

```jsx
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { PurchaseOrderLineRow } from './PurchaseOrderLineRow.jsx';

const STATUS_CLASS = {
  draft:    'bg-gray-300',
  ordered:  'bg-amber-500',
  received: 'bg-emerald-500',
};

export function PurchaseOrderCard({ po: initialPo, speciesById, showToast, onChanged, setConfirmDialog }) {
  const [po, setPo]   = useState(initialPo);
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingHeader, setSavingHeader] = useState(false);

  // Local header state — edited while typing, flushed on blur.
  const [supplier,    setSupplier]    = useState(po.supplier || '');
  const [shippingFee, setShippingFee] = useState(String(po.shippingFee ?? 0));
  const [notes,       setNotes]       = useState(po.notes || '');

  useEffect(() => { setPo(initialPo); }, [initialPo.id, initialPo.status, initialPo.lineCount, initialPo.unitCount]);
  useEffect(() => { setSupplier(po.supplier || ''); }, [po.id, po.supplier]);
  useEffect(() => { setShippingFee(String(po.shippingFee ?? 0)); }, [po.id, po.shippingFee]);
  useEffect(() => { setNotes(po.notes || ''); }, [po.id, po.notes]);

  const refreshLines = async () => {
    setLoading(true);
    try {
      const { purchaseOrder, lines: ls } = await api.getPurchaseOrder(po.id);
      setPo(purchaseOrder);
      setLines(ls);
    } catch (e) {
      showToast?.(e.message || 'Load failed', 3000);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && lines === null) refreshLines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const flushHeader = async (patch) => {
    setSavingHeader(true);
    try {
      const updated = await api.updatePurchaseOrderHeader({ id: po.id, ...patch });
      setPo(prev => ({ ...prev, ...updated }));
    } catch (e) {
      showToast?.(e.message || 'Save failed', 3000);
    } finally {
      setSavingHeader(false);
    }
  };

  const deletePo = () => {
    setConfirmDialog?.({
      title: 'Delete this draft?',
      message: 'This removes the PO and all its lines. Cannot be undone (it goes through the 30-day soft-delete pattern).',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deletePurchaseOrder(po.id);
          showToast?.('Deleted', 1500);
          onChanged?.();
        } catch (e) {
          showToast?.(e.message || 'Delete failed', 3000);
        }
      },
    });
  };

  const isDraft = po.status === 'draft';

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50"
      >
        <div className="mt-0.5 text-gray-400">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block w-2 h-2 rounded-full ${STATUS_CLASS[po.status] || 'bg-gray-300'}`} />
            <span className="font-medium text-gray-900 capitalize">{po.status}</span>
            <span className="text-gray-500">·</span>
            <span className="text-gray-700">{new Date(po.createdAt).toISOString().slice(0, 10)}</span>
            {po.supplier && (
              <>
                <span className="text-gray-500">·</span>
                <span className="text-gray-700 truncate">{po.supplier}</span>
              </>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {po.lineCount} {po.lineCount === 1 ? 'line' : 'lines'}
            {' · '}
            {po.unitCount} {po.unitCount === 1 ? 'unit' : 'units'}
            {po.shippingFee > 0 && ` + $${parseFloat(po.shippingFee).toFixed(2)} ship`}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          {/* Header editors */}
          <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-3 bg-gray-50/60">
            <Field label="Supplier">
              <input
                type="text"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                onBlur={() => supplier !== (po.supplier || '') && flushHeader({ supplier })}
                disabled={po.status === 'received'}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
            <Field label="Shipping ($)">
              <input
                type="number"
                step="0.01"
                value={shippingFee}
                onChange={(e) => setShippingFee(e.target.value)}
                onBlur={() => parseFloat(shippingFee) !== Number(po.shippingFee) && flushHeader({ shippingFee: parseFloat(shippingFee) || 0 })}
                disabled={po.status === 'received'}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
            <Field label="Notes">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => notes !== (po.notes || '') && flushHeader({ notes })}
                disabled={po.status === 'received'}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
          </div>

          {/* Lines */}
          {loading ? (
            <div className="p-6 text-center text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading lines…
            </div>
          ) : !lines || lines.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              No lines yet. Add plants from the Catalog tab.
            </div>
          ) : (
            <div>
              {lines.map(line => (
                <PurchaseOrderLineRow
                  key={line.id}
                  line={line}
                  species={speciesById?.get(line.speciesId)}
                  poStatus={po.status}
                  poId={po.id}
                  showToast={showToast}
                  onChanged={refreshLines}
                />
              ))}
            </div>
          )}

          {/* Footer actions */}
          {isDraft && lines && (
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={deletePo}
                disabled={savingHeader}
                className="flex items-center gap-1.5 px-3 py-2 text-sm border border-red-200 text-red-700 rounded-lg hover:bg-red-50"
              >
                <Trash2 className="w-4 h-4" /> Delete PO
              </button>
              {/* Mark ordered button lives here in Task 14. */}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}
```

- [ ] **Step 3: Build a `speciesById` map and pass it from `OrdersPane`**

In `OrdersPane.jsx`, replace the existing `PurchaseOrderCard` render with one that passes `speciesById`, `showToast`, `onChanged`, and `setConfirmDialog`. First, accept those new props in the signature:

```jsx
export function OrdersPane({ species, currentUser, showToast, setConfirmDialog }) {
```

Below `const refresh = useCallback(...)`, add:

```jsx
  const speciesById = useMemo(() => {
    const m = new Map();
    for (const s of species || []) m.set(s.id, s);
    return m;
  }, [species]);
```

Add `useMemo` to the existing `useMemo` import line if it isn't there.

Update the list-render block:

```jsx
        <div className="space-y-2">
          {pos.map(po => (
            <PurchaseOrderCard
              key={po.id}
              po={po}
              speciesById={speciesById}
              showToast={showToast}
              setConfirmDialog={setConfirmDialog}
              onChanged={refresh}
            />
          ))}
        </div>
```

- [ ] **Step 4: Manually verify**

1. Use the draft from Task 12. Expand it — header editors appear and the single line shows with the photo + qty + price inputs.
2. Change qty to 3 → blur → row updates, the collapsed row's unit count refreshes after expand-close-open.
3. Change supplier to "Bob's" → blur → next time you collapse and expand, supplier persists.
4. Click the trash on a line → it disappears.
5. Click **Delete PO** → confirm dialog → PO disappears from the list.

- [ ] **Step 5: Commit**

```bash
git add src/purchasing/PurchaseOrderCard.jsx src/purchasing/PurchaseOrderLineRow.jsx src/purchasing/OrdersPane.jsx
git commit -m "purchasing: PO expand + header edit + line CRUD (draft state)"
```

---

## Task 14: UI — Mark ordered + Receive flow

**Files:**
- Modify: `src/purchasing/PurchaseOrderCard.jsx` (add Mark ordered + Mark all received buttons)
- Modify: `src/purchasing/PurchaseOrderLineRow.jsx` (add the Receive input + button when status=ordered)

- [ ] **Step 1: Add Mark ordered + Mark all received to `PurchaseOrderCard.jsx`**

In `PurchaseOrderCard.jsx`, add to the imports:

```jsx
import { Check, Truck } from 'lucide-react';
```

Below `const deletePo = () => { ... };` add:

```jsx
  const markOrdered = async () => {
    try {
      const updated = await api.markPurchaseOrderOrdered(po.id);
      setPo(prev => ({ ...prev, ...updated }));
      await refreshLines();
      onChanged?.();
      showToast?.('Marked as ordered', 1500);
    } catch (e) {
      showToast?.(e.message || 'Failed', 3000);
    }
  };

  const markAllReceived = async () => {
    if (!lines) return;
    const targets = lines.filter(l => l.quantityReceived < l.quantityOrdered);
    if (targets.length === 0) {
      showToast?.('Already fully received', 1500);
      return;
    }
    try {
      for (const l of targets) {
        await api.receivePurchaseOrderLine({
          id: po.id,
          lineId: l.id,
          quantityReceived: l.quantityOrdered - l.quantityReceived,
        });
      }
      await refreshLines();
      onChanged?.();
      showToast?.('Marked all received', 1800);
    } catch (e) {
      showToast?.(e.message || 'Receive failed', 3000);
      await refreshLines();
    }
  };
```

Update the footer-actions block:

```jsx
          {/* Footer actions */}
          {(isDraft || po.status === 'ordered') && lines && (
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
              {isDraft && (
                <>
                  <button
                    type="button"
                    onClick={deletePo}
                    disabled={savingHeader}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm border border-red-200 text-red-700 rounded-lg hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4" /> Delete PO
                  </button>
                  <button
                    type="button"
                    onClick={markOrdered}
                    disabled={lines.length === 0}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-60"
                  >
                    <Check className="w-4 h-4" /> Mark ordered
                  </button>
                </>
              )}
              {po.status === 'ordered' && (
                <button
                  type="button"
                  onClick={markAllReceived}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg"
                >
                  <Truck className="w-4 h-4" /> Mark all received
                </button>
              )}
            </div>
          )}
```

- [ ] **Step 2: Add the Receive input + button to `PurchaseOrderLineRow.jsx`**

In `PurchaseOrderLineRow.jsx`, at the top of the imports, add:

```jsx
import { Trash2, Loader2, Check } from 'lucide-react';
```

Add local state for the received-input near the other useStates:

```jsx
  const remaining = Math.max(0, line.quantityOrdered - line.quantityReceived);
  const [receiveQty, setReceiveQty] = useState(String(remaining));

  useEffect(() => { setReceiveQty(String(remaining)); }, [remaining]);

  const doReceive = async () => {
    const n = parseInt(receiveQty, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    try {
      const r = await api.receivePurchaseOrderLine({ id: poId, lineId: line.id, quantityReceived: n });
      if (r?.poFlippedToReceived) {
        showToast?.('Received — PO complete', 2200);
      } else {
        showToast?.(`Received ${n}`, 1500);
      }
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Receive failed', 3000);
    } finally {
      setBusy(false);
    }
  };
```

Replace the second half of the JSX (the metadata + actions part) — find the block starting `{!isDraft && (` near the end and replace through the closing `</div>` of the line row with:

```jsx
          {!isDraft && (
            <span className="ml-auto flex items-center gap-2">
              <span className="text-gray-500">
                Received <span className="font-semibold text-gray-900">{line.quantityReceived}</span>/{line.quantityOrdered}
                {line.quantityReceived > line.quantityOrdered && (
                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
                    +{line.quantityReceived - line.quantityOrdered} over
                  </span>
                )}
              </span>
              {poStatus === 'ordered' && remaining > 0 && (
                <>
                  <input
                    type="number"
                    min={1}
                    value={receiveQty}
                    onChange={(e) => setReceiveQty(e.target.value)}
                    className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
                  />
                  <button
                    type="button"
                    onClick={doReceive}
                    disabled={busy}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded disabled:opacity-60"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    Receive
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      </div>
      {isDraft && (
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="shrink-0 p-1.5 text-gray-400 hover:text-red-600 rounded"
          title="Remove line"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Refresh items in App.jsx after a receive**

In `OrdersPane.jsx`, expand the `refresh` callback so it ALSO bumps the inventory (since receive creates SKUs):

```jsx
  const refresh = useCallback(async () => {
    setErr('');
    try {
      const statuses = [...activeFilters].join(',') || 'draft,ordered';
      const fresh = await api.listPurchaseOrders(statuses);
      setPos(fresh);
      onItemsChanged?.();
    } catch (e) {
      setErr(e.message || 'Load failed');
    }
  }, [activeFilters, onItemsChanged]);
```

Accept `onItemsChanged` in the props destructuring at the top of `OrdersPane`:

```jsx
export function OrdersPane({ species, currentUser, showToast, setConfirmDialog, onItemsChanged }) {
```

- [ ] **Step 4: Manually verify the full lifecycle**

1. Open a draft → click **Mark ordered**. Lines lock (qty/price inputs disabled), status pill flips to amber.
2. On a 5-unit line, type `2` into the receive input → click Receive. Line shows `Received 2/5`. Open the **Inventory** tab → 2 new SKUs with the species's name and `grossCost = unitWholesalePrice + shippingFee/totalOrdered`.
3. Type `4` into the receive input on the same line → click Receive. Line shows `Received 6/5` with the orange `+1 over` chip. If the rest of the PO is complete, the PO flips to received (emerald pill); collapse and re-expand to confirm.
4. Click **Mark all received** on a fresh ordered PO with two partially-received lines → both lines fill, PO flips.

- [ ] **Step 5: Commit**

```bash
git add src/purchasing/PurchaseOrderCard.jsx src/purchasing/PurchaseOrderLineRow.jsx src/purchasing/OrdersPane.jsx
git commit -m "purchasing: mark-ordered + receive flow (per-line + mark-all)"
```

---

## Task 15: UI — Cancel-receive + Draft mini-bar

**Files:**
- Modify: `src/purchasing/PurchaseOrderLineRow.jsx` (Cancel-receive button on lines with available SKUs)
- Modify: `src/purchasing/PurchaseOrderCard.jsx` (pass receivedItems so the line knows what's cancelable)
- Create: `src/purchasing/DraftMiniBar.jsx`
- Modify: `src/purchasing/CatalogPane.jsx` (render the mini-bar)
- Modify: `src/purchasing/PurchasingView.jsx` (allow CatalogPane to flip to Orders sub-tab)

- [ ] **Step 1: Pass `receivedItems` through to line rows**

In `PurchaseOrderCard.jsx`, update `refreshLines`:

```jsx
  const [receivedItems, setReceivedItems] = useState([]);

  const refreshLines = async () => {
    setLoading(true);
    try {
      const { purchaseOrder, lines: ls, receivedItems: ri } = await api.getPurchaseOrder(po.id);
      setPo(purchaseOrder);
      setLines(ls);
      setReceivedItems(ri || []);
    } catch (e) {
      showToast?.(e.message || 'Load failed', 3000);
    } finally {
      setLoading(false);
    }
  };
```

In the lines render block, pass `receivedItems`:

```jsx
              {lines.map(line => (
                <PurchaseOrderLineRow
                  key={line.id}
                  line={line}
                  species={speciesById?.get(line.speciesId)}
                  receivedItemIds={receivedItems.filter(r => r.lineId === line.id).map(r => r.inventoryItemId)}
                  poStatus={po.status}
                  poId={po.id}
                  showToast={showToast}
                  onChanged={refreshLines}
                />
              ))}
```

- [ ] **Step 2: Add Cancel-receive button to `PurchaseOrderLineRow.jsx`**

In the function signature, accept `receivedItemIds`:

```jsx
export function PurchaseOrderLineRow({ line, species, receivedItemIds = [], poStatus, poId, showToast, onChanged }) {
```

Add the cancel handler near the other handlers:

```jsx
  const cancelReceive = async () => {
    setBusy(true);
    try {
      const r = await api.cancelReceivePurchaseOrderLine({ id: poId, lineId: line.id });
      showToast?.(`Cancelled ${r.deletedCount} unit${r.deletedCount === 1 ? '' : 's'}`, 2000);
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Cancel failed', 3000);
    } finally { setBusy(false); }
  };
```

In the `!isDraft && (...)` block, just after the `Received N/M` span (still inside the same `<span className="ml-auto ...">`), add:

```jsx
              {!isDraft && line.quantityReceived > 0 && receivedItemIds.length > 0 && (
                <button
                  type="button"
                  onClick={cancelReceive}
                  disabled={busy}
                  className="text-xs px-2 py-1 border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
                  title="Soft-delete any still-available SKUs from this line and roll back the count"
                >
                  Cancel receive
                </button>
              )}
```

(The server-side enforces the "only-cancel-available-SKUs" rule, so this button is shown whenever there's at least one received item at all — the server returns a 409 if every SKU has moved past `available`, and the toast surfaces the error.)

- [ ] **Step 3: Create `DraftMiniBar.jsx`**

Create `src/purchasing/DraftMiniBar.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { ShoppingCart, ArrowRight } from 'lucide-react';
import { api } from '../api.js';

// Sticky-bottom prompt shown when there's an active draft PO.
// Polls the draft list on a small interval so it stays current as
// the operator adds plants from the catalog. (Polling is cheap —
// list endpoint is one indexed SELECT.)
export function DraftMiniBar({ onOpen }) {
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const drafts = await api.listPurchaseOrders('draft');
        if (alive) setDraft(drafts && drafts[0] ? drafts[0] : null);
      } catch { /* swallow — bar is best-effort */ }
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  if (!draft || (draft.lineCount === 0 && draft.unitCount === 0)) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 sm:left-auto sm:right-4 sm:bottom-4 sm:max-w-md z-30 pb-safe sm:pb-0">
      <div className="bg-gray-900 text-white sm:rounded-2xl shadow-2xl px-4 py-3 mb-14 sm:mb-0 flex items-center gap-3">
        <ShoppingCart className="w-5 h-5 text-emerald-300 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-400">Draft PO</div>
          <div className="text-sm font-medium truncate">
            {draft.lineCount} plant{draft.lineCount === 1 ? '' : 's'} · {draft.unitCount} unit{draft.unitCount === 1 ? '' : 's'}
            {draft.supplier && ` · ${draft.supplier}`}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 rounded-lg shrink-0"
        >
          Open <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Render `DraftMiniBar` from `CatalogPane`**

In `CatalogPane.jsx`, add to imports:

```jsx
import { DraftMiniBar } from './DraftMiniBar.jsx';
```

Accept a new `onSwitchToOrders` prop:

```jsx
export function CatalogPane({ varieties, species, currentUser, showToast, onSpeciesChanged, onSwitchToOrders }) {
```

Just before the modal render block, add:

```jsx
      <DraftMiniBar onOpen={() => onSwitchToOrders?.()} />
```

- [ ] **Step 5: Wire `onSwitchToOrders` from `PurchasingView.jsx`**

In `PurchasingView.jsx`, pass it through:

```jsx
      {sub === 'catalog' && (
        <CatalogPane
          varieties={varieties}
          species={species}
          currentUser={currentUser}
          showToast={showToast}
          onSpeciesChanged={onSpeciesChanged}
          onSwitchToOrders={() => setSub('orders')}
        />
      )}
```

- [ ] **Step 6: Manually verify**

1. With a draft PO containing at least one line, switch to Catalog → the dark mini-bar appears at the bottom showing the line/unit count. Click **Open** → routes to Orders.
2. Delete every line on the draft (back in Orders) → mini-bar disappears within ~4 seconds.
3. On a fully-received PO, click **Cancel receive** on a line — toast confirms the count cancelled. Open Inventory → those SKUs are now in Recently Deleted (or hidden from the default view). PO flips back to `ordered`.
4. Try Cancel receive again on the same line — toast shows the "nothing to cancel" 409 message.

- [ ] **Step 7: Commit**

```bash
git add src/purchasing/PurchaseOrderCard.jsx src/purchasing/PurchaseOrderLineRow.jsx src/purchasing/DraftMiniBar.jsx src/purchasing/CatalogPane.jsx src/purchasing/PurchasingView.jsx
git commit -m "purchasing: cancel-receive button + draft mini-bar"
```

---

## Task 16: Cleanup — remove the old component + final smoke test

**Files:**
- Delete: `src/purchasing/PurchaseOrderView.jsx`

The lazy import in `App.jsx` already points at `PurchasingView.jsx` (Task 8). The old file is unused.

- [ ] **Step 1: Verify nothing imports the old file**

```bash
grep -rn "PurchaseOrderView" /Users/coreyzhang/Projects/plant-inventory/src 2>&1
```

Expected: no matches (or only matches inside the file we're about to delete).

- [ ] **Step 2: Delete the old file**

```bash
git -C /Users/coreyzhang/Projects/plant-inventory rm src/purchasing/PurchaseOrderView.jsx
```

- [ ] **Step 3: Run the full spec smoke test pass**

Walk through every item in the spec's section 9 ("Testing"), end-to-end, in one session:

1. Open a species card, set wholesale + ideal prices, save, reopen — values persist.
2. Upload 3 photos to a plant, reorder via drag, set primary, delete the primary — second-in-order becomes primary visually.
3. Tap "+ Add to draft" on a Catalog plant — mini-bar appears with 1 plant / 1 unit / cost equal to wholesale.
4. Add the same plant again — count increments, no duplicate line.
5. Mark ordered — flips to ordered, lines lock, mini-bar disappears (draft is gone).
6. Receive line partial — type 5 into a 10-line, hit Receive → Inventory shows 5 new SKUs with `grossCost = unitWholesalePrice + perUnitShipping`; line shows Received 5/10; PO still ordered.
7. Receive remainder — type 5 more → 5 more SKUs; PO flips to received if all other lines full.
8. Cancel-receive on a fully-received line — soft-deletes still-`available` SKUs, decrements count, PO flips back to ordered. Items already `listed`/`sold` stay.
9. Over-receive — type 12 into a 10-line, hit Receive → 12 SKUs created, warning chip shown, PO can still flip to received.
10. Mark all received — fresh ordered PO → every line receives its remaining qty, PO flips.
11. Delete a draft → row disappears.
12. Audit trace — in Supabase SQL Editor: `select * from purchase_order_received_items where "inventoryItemId" = '<some sku id>';` → returns the originating `lineId`, traceable back to the PO via the lines table.

Any failure ⇒ go back and fix the relevant task, then re-run the failing item.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "purchasing: remove old PurchaseOrderView (replaced by PurchasingView)"
```

---

## Self-review

This is the checklist run after writing the plan, to catch issues before handoff.

**Spec coverage:**
- Data model (species cols, species_photos, purchase_orders, purchase_order_lines, purchase_order_received_items) → Task 1.
- `/api/species` extensions → Task 2.
- `/api/species-photos` (upload/delete/reorder + signed-url) → Task 3.
- `/api/purchase-orders` draft CRUD → Task 4.
- `/api/purchase-orders` mark-ordered → Task 5.
- `/api/purchase-orders` receive-line + cancel-receive-line → Task 6.
- `src/api.js` client extensions → Task 7.
- `PurchasingView` shell + sub-tab routing → Task 8.
- Catalog grid + cards → Task 9.
- Plant detail modal (catalog edit) → Task 10.
- Photo gallery (multi-photo CRUD) → Task 11.
- Orders list + draft creation + "+ Add to draft" → Task 12.
- PO expand + header edit + line CRUD → Task 13.
- Mark ordered + receive flow + Mark all received → Task 14.
- Cancel-receive + Draft mini-bar → Task 15.
- Cleanup (delete old component) + smoke test → Task 16.

All spec sections accounted for.

**Placeholder scan:** No "TBD", no "implement later" (the Task 4 stubs are explicit placeholders for Task 5/6, called out in code comments and filled in before any UI consumes them — acceptable). All steps have concrete code or commands.

**Type consistency:** The API names match across server and client: `markPurchaseOrderOrdered`, `receivePurchaseOrderLine`, `cancelReceivePurchaseOrderLine`. The `speciesPhotoSignedUrl` client method matches the `?action=signed-url` GET. The `purchase_order_lines.unitWholesalePrice` column is referenced consistently across schema, API, client, and the line row component.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-purchasing-catalog-and-receive.md`.
