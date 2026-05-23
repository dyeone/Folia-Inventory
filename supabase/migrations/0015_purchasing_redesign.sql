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
