-- Folia Inventory — Supabase Schema
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New Query)
--
-- Column names use double-quoted camelCase to match the JavaScript object keys
-- exactly, so no mapping layer is needed in the app.

-- ─── Users ────────────────────────────────────────────────────────────────────
-- Stores app users with hashed passwords (SHA-256).
-- This is a custom auth table; Supabase Auth is NOT used.

create table if not exists users (
  id            text        primary key,
  username      text        unique not null,
  "displayName" text,
  "passwordHash" text       not null,
  role          text        not null default 'staff' check (role in ('admin','staff','packer')),
  active        boolean     not null default true,
  "createdAt"   timestamptz not null default now()
);

-- Long-lived bearer token the local Folia Bridge uses to poll for jobs.
-- Issued on demand via /api/bridge?action=generate-token; rotating it
-- invalidates a running bridge instantly.
alter table users add column if not exists "bridgeToken" text;
create unique index if not exists users_bridge_token_idx
  on users ("bridgeToken")
  where "bridgeToken" is not null;

-- Heartbeat from a running bridge. /next writes this on every poll
-- (~1.5 s); /health uses it to decide whether to show the bridge as
-- online — replaces the prior "infer from recent job activity" trick
-- that gave false-offline readings whenever the bridge was idle.
alter table users add column if not exists "bridgeLastSeen" timestamptz;

-- ─── Inventory Items ──────────────────────────────────────────────────────────

create table if not exists inventory_items (
  id                    text        primary key,
  sku                   text        not null,
  type                  text        not null check (type in ('tc','plant')),
  name                  text,
  variety               text,
  quantity              integer,
  "grossCost"           numeric,
  cost                  numeric,      -- legacy alias for grossCost
  "netCost"             numeric,
  "profitRate"          numeric,
  "idealPrice"          numeric,
  "listingPrice"        numeric,
  "salePrice"           numeric,
  status                text        not null default 'available'
                          check (status in ('available','listed','sold','shipped','delivered','converted')),
  source                text,
  "acquiredAt"          text,
  notes                 text,
  "imageUrl"            text,
  "saleId"              text,
  "lotNumber"           text,
  "convertedFromTcId"   text,
  "convertedFromSku"    text,
  "convertedToPlantId"  text,
  "convertedAt"         text,
  "convertedBy"         text,
  "createdAt"           timestamptz not null default now(),
  "createdBy"           text,
  "modifiedAt"          timestamptz,
  "modifiedBy"          text,
  "soldAt"              timestamptz
);

-- ─── Sales Events ─────────────────────────────────────────────────────────────

create table if not exists sales (
  id          text        primary key,
  name        text        not null,
  date        text,
  platform    text        not null default 'Palmstreet',
  notes       text,
  "createdAt" timestamptz not null default now(),
  "createdBy" text
);

-- Sale event lifecycle: ongoing (being built / live / pre-handoff)
-- → packing (sent to Packing tab, file may or may not be uploaded yet)
-- → closed (every box shipped; archived).
alter table sales add column if not exists status text;
alter table sales add column if not exists "startTime" timestamptz;
alter table sales add column if not exists "durationMinutes" integer;
alter table sales add column if not exists "itemTypes" text;
alter table sales add column if not exists "closedAt" timestamptz;
alter table sales add column if not exists "exportedAt" timestamptz;
update sales set status = 'ongoing' where status is null;
alter table sales alter column status set default 'ongoing';
alter table sales alter column status set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_status_check') then
    alter table sales add constraint sales_status_check
      check (status in ('ongoing','packing','closed'));
  end if;
end $$;

-- Per-item buyer / shipping data populated when a Palmstreet orders file is
-- uploaded for a sale event. lotKind separates live-sale lots from
-- giveaways assigned during lineup building.
alter table inventory_items add column if not exists "lotKind" text default 'sale';
alter table inventory_items add column if not exists "buyer" text;
alter table inventory_items add column if not exists "buyerUsername" text;
alter table inventory_items add column if not exists "buyerAddress" jsonb;
alter table inventory_items add column if not exists "shipmentBoxId" text;
alter table inventory_items add column if not exists "shippedAt" timestamptz;
-- Per-item packing flag for the Shipping tab. null = unpacked, set =
-- packed (timestamp = when the operator marked it). Independent of
-- status, which stays 'sold' through pack-out.
alter table inventory_items add column if not exists "packedAt" timestamptz;
-- 'unmatched' is for placeholder rows created by Validate Sales when a
-- Palmstreet order line's SKU didn't match real inventory — see
-- migration 0011.
alter table inventory_items drop constraint if exists inventory_items_lotkind_check;
alter table inventory_items add constraint inventory_items_lotkind_check
  check ("lotKind" in ('sale','giveaway','unmatched'));

-- Order-level details captured from the Palmstreet orders file (so we can
-- reconcile against the cashflow report by Order No), plus refund tracking
-- populated when the cashflow report is uploaded in the Financial tab.
alter table inventory_items add column if not exists "orderId" text;
alter table inventory_items add column if not exists "orderDate" timestamptz;
alter table inventory_items add column if not exists "refundedAmount" numeric default 0;
alter table inventory_items add column if not exists "refundedAt" timestamptz;
-- Shipping fee the buyer paid for this line, taken from the Palmstreet
-- order's "Shipping Fee" column at Validate-Sales time. Stored per item
-- (split evenly across a bundled row's SKUs, mirroring price) so summing
-- a box's items reproduces the total the buyer paid to ship that box. The
-- Shipping tab compares that sum against the label cost to flag boxes we
-- lose money shipping.
alter table inventory_items add column if not exists "orderShippingFee" numeric;
create index if not exists inventory_items_orderid_idx on inventory_items ("orderId");

-- Carrier the box should ship by ('usps' default, 'ups' if the buyer paid
-- for the "UPS 2-Day Upgrade" line item in their Palmstreet order). Set at
-- the item level rather than a separate shipments row so the Packing tab
-- can group by carrier without an extra join.
alter table inventory_items add column if not exists "shipmentCarrier" text default 'usps';

-- Per-item review flag. Validate Sales sets 'double_sale' on the already-
-- shipped item AND on the new flagged second-sale line when a SKU appears to
-- have sold twice (order #/buyer/address/date don't match the shipped box).
-- null = nothing to review. See migration 0026.
alter table inventory_items add column if not exists "reviewFlag" text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_reviewflag_check') then
    alter table inventory_items add constraint inventory_items_reviewflag_check
      check ("reviewFlag" is null or "reviewFlag" in ('double_sale'));
  end if;
end $$;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_shipcarrier_check') then
    alter table inventory_items add constraint inventory_items_shipcarrier_check
      check ("shipmentCarrier" in ('usps','ups'));
  end if;
end $$;
create index if not exists inventory_items_shipcarrier_idx on inventory_items ("shipmentCarrier");

-- Soft-delete with a 30-day grace window. The API filters deletedAt rows
-- out of the main inventory and exposes them through a "Recently Deleted"
-- view; rows past the 30-day mark are hard-purged the next time the API
-- reads items.
alter table inventory_items add column if not exists "deletedAt" timestamptz;
alter table inventory_items add column if not exists "deletedBy" text;
create index if not exists inventory_items_deletedat_idx on inventory_items ("deletedAt");

-- Allow 'refunded' (full refunds; partials keep sold/shipped + refundedAmount)
-- and 'acclimated' (TCs in poor condition that got potted to recover and
-- will be sold as grown plants later, at a higher profit rate).
alter table inventory_items drop constraint if exists inventory_items_status_check;
alter table inventory_items add constraint inventory_items_status_check
  check (status in ('available','listed','sold','shipped','delivered','converted','refunded','acclimated'));

-- ─── Catalog: Varieties (Genus) + Species ────────────────────────────────────
-- A two-level catalog so items can be hierarchically classified:
--   variety (genus, e.g. Alocasia)  →  species (e.g. sinuata 'Aurea')
-- Items keep `variety` and `name` text columns denormalized for quick reads
-- and to avoid breaking any code that reads them directly; speciesId is the
-- canonical link when set.

create table if not exists varieties (
  id          text        primary key,
  name        text        unique not null,
  code        text        not null,                  -- 3-letter SKU prefix (ALO, ANT, MON, JOR…)
  "createdAt" timestamptz not null default now(),
  "createdBy" text
);
-- Per-variety default profit rate. Used as the fallback when an item has no
-- explicit rate of its own; falls through to the global dashboard rate when
-- this is null too.
alter table varieties add column if not exists "profitRate" numeric;

create table if not exists species (
  id           text        primary key,
  "varietyId"  text        not null references varieties(id) on delete restrict,
  epithet      text        not null,                 -- the species/cultivar name, free text
  "commonName" text,
  notes        text,
  "imageUrl"   text,
  "createdAt"  timestamptz not null default now(),
  "createdBy"  text,
  unique ("varietyId", epithet)
);
-- Per-cultivar profit rate. Used as the fallback when an item has no rate of
-- its own; falls through to the global dashboard rate when this is null too.
alter table species add column if not exists "profitRate" numeric;

-- Items get an optional FK to the species catalog. Nullable so existing
-- rows (and ad-hoc imports) keep working; when set, the form auto-syncs
-- the denormalized variety + name on the item.
alter table inventory_items add column if not exists "speciesId" text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_species_fk') then
    alter table inventory_items
      add constraint inventory_items_species_fk
      foreign key ("speciesId") references species(id) on delete set null;
  end if;
end $$;
create index if not exists inventory_items_speciesid_idx on inventory_items ("speciesId");

-- Seed the four built-in varieties from the original constants list. Safe
-- to re-run; uses ON CONFLICT to leave existing rows alone.
insert into varieties (id, name, code) values
  ('var_alocasia',     'Alocasia',     'ALO'),
  ('var_anthurium',    'Anthurium',    'ANT'),
  ('var_monstera',     'Monstera',     'MON'),
  ('var_jewel_orchid', 'Jewel Orchid', 'JWL')
on conflict (name) do nothing;

-- Backfill any existing Jewel-Orchid rows that were seeded with the old
-- 'JOR' prefix or auto-created from a bulk import as 'JEW'. Idempotent.
update varieties set code = 'JWL'
  where name ilike 'jewel%orchid%' and code <> 'JWL';

-- Backfill species from existing distinct (variety, name) pairs on items.
-- Skips rows where variety or name is empty. Uses md5 for a deterministic
-- id so re-running doesn't duplicate.
insert into species (id, "varietyId", epithet)
select
  'sp_' || substr(md5(v.id || '|' || i.name), 1, 16) as id,
  v.id as "varietyId",
  i.name as epithet
from (
  select distinct variety, name
  from inventory_items
  where coalesce(variety, '') <> '' and coalesce(name, '') <> ''
) i
join varieties v on v.name = i.variety
on conflict ("varietyId", epithet) do nothing;

-- Link existing items to their backfilled species rows.
update inventory_items i
set "speciesId" = s.id
from species s
join varieties v on v.id = s."varietyId"
where i."speciesId" is null
  and i.variety = v.name
  and i.name = s.epithet;

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

-- 0016 · classify each photo as gallery vs the per-species parent
-- slots (mother / father) used for Anthurium parentage records.
alter table species_photos add column if not exists "kind" text not null default 'gallery';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'species_photos_kind_check') then
    alter table species_photos
      add constraint species_photos_kind_check
      check ("kind" in ('gallery','mother','father'));
  end if;
end $$;
create index if not exists species_photos_species_kind_idx
  on species_photos ("speciesId", "kind");

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

-- ─── Constraints ──────────────────────────────────────────────────────────────
-- Enforce SKU uniqueness across all inventory items. Using a unique index
-- with IF NOT EXISTS so this is safe to re-run. If existing rows already
-- contain duplicate SKUs, this statement will fail — resolve the duplicates
-- first, then re-run.
create unique index if not exists inventory_items_sku_unique
  on inventory_items (sku);

-- ─── Auth attempts (login rate limiting) ─────────────────────────────────────
-- One row per attempted login. The auth handler counts recent failures
-- per username and locks the account for 15 min after 10 failures inside
-- a 15-minute window. Row is also written on success (succeeded=true) so
-- we can show "last login" if we ever want to. Old rows are best-effort
-- purged by the auth handler.

create table if not exists auth_attempts (
  id          bigserial   primary key,
  username    text        not null,
  succeeded   boolean     not null,
  ip          text,
  "attemptedAt" timestamptz not null default now()
);
create index if not exists auth_attempts_username_time_idx
  on auth_attempts (username, "attemptedAt" desc);

-- ─── App settings ─────────────────────────────────────────────────────────────
-- Single-row JSON blob keyed by `id` so we can read/write things like the
-- ship-from address and ShipStation defaults without a column-by-column
-- migration every time the shape changes. The app uses id='shipping' for
-- everything ShipStation-related.

create table if not exists app_settings (
  id          text        primary key,
  data        jsonb       not null default '{}'::jsonb,
  "updatedAt" timestamptz not null default now(),
  "updatedBy" text
);

-- ─── Shipments (ShipStation labels) ──────────────────────────────────────────
-- One row per packing box (= shipmentBoxId on inventory_items). Created the
-- moment a label is purchased; voiding sets voidedAt instead of deleting so
-- we keep the audit trail and the labelData/tracking history.
--
-- labelData holds the base64 PDF returned by ShipStation. For most packing
-- volumes that's fine; if it ever gets large we can move it to Supabase
-- Storage and keep just a URL here.

create table if not exists shipments (
  id                       text        primary key,            -- = shipmentBoxId on inventory_items
  "saleId"                 text,
  carrier                  text        not null check (carrier in ('usps','ups')),
  "carrierCode"            text        not null,
  "serviceCode"            text        not null,
  "packageCode"            text        not null default 'package',
  "weightOz"               numeric,                              -- nullable: not meaningful for Palmstreet-USPS rows
  "dimsLength"             numeric,
  "dimsWidth"              numeric,
  "dimsHeight"             numeric,
  "shipFrom"               jsonb,                                -- nullable: see weightOz
  "shipTo"                 jsonb,                                -- nullable: see weightOz
  "trackingNumber"         text,
  "labelCost"              numeric,
  "labelData"              text,                                -- legacy: base64 PDF (pre-storage cutover)
  "labelStoragePath"       text,                                -- path within `shipping-labels` Storage bucket
  "shippingSlipStoragePath" text,                               -- second PDF: packing slip (Palmstreet flow)
  "shipstationShipmentId"  text,
  "shipstationLabelId"     text,
  provider                 text,                                 -- 'shipstation' | 'shippo' | 'palmstreet' (null = legacy ShipStation)
  "shippoTransactionId"    text,                                 -- Shippo transaction id, for refunds
  "isTestLabel"            boolean     not null default false,
  "purchasedAt"            timestamptz not null default now(),
  "purchasedBy"            text,
  "voidedAt"               timestamptz,
  "voidedBy"               text
);
alter table shipments add column if not exists provider text;
alter table shipments add column if not exists "shippoTransactionId" text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shipments_provider_check') then
    alter table shipments add constraint shipments_provider_check
      check (provider is null or provider in ('shipstation','shippo','palmstreet'));
  end if;
end $$;
create index if not exists shipments_saleid_idx on shipments ("saleId");
create index if not exists shipments_carrier_idx on shipments (carrier);

alter table app_settings enable row level security;
alter table shipments    enable row level security;

-- ─── Shipment boxes ──────────────────────────────────────────────────────────
-- Per-box metadata (operator's seller-note + packaging selection).
-- Lazy-created the first time a note OR packaging is saved; missing row =
-- nothing set. See migrations 0018 (note) and 0022 (packaging).
--   boxSizeId  → a boxSizes preset id from app_settings.id='shipping'
--   weightOz   → actual per-box weight used for rate quotes
--   serviceKey → one of the three offered services (see 0022 check)

create table if not exists shipment_boxes (
  id                text        primary key,            -- = shipmentBoxId on inventory_items
  note              text,
  "boxSizeId"       text,
  "weightOz"        numeric,
  "serviceKey"      text,
  "carrierOverride" text,
  "holdUntil"       timestamptz,                            -- one-week hold (0028); null = not held
  "updatedAt"       timestamptz not null default now(),
  "updatedBy"       text
);
alter table shipment_boxes add column if not exists "boxSizeId" text;
alter table shipment_boxes add column if not exists "weightOz"  numeric;
alter table shipment_boxes add column if not exists "serviceKey" text;
alter table shipment_boxes add column if not exists "carrierOverride" text;
alter table shipment_boxes add column if not exists "holdUntil" timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shipment_boxes_servicekey_check') then
    alter table shipment_boxes add constraint shipment_boxes_servicekey_check
      check ("serviceKey" is null or "serviceKey" in
        ('usps_priority','ups_2nd_day_air','ups_next_day_air_saver'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shipment_boxes_carrieroverride_check') then
    alter table shipment_boxes add constraint shipment_boxes_carrieroverride_check
      check ("carrierOverride" is null or "carrierOverride" in ('usps','ups'));
  end if;
end $$;

alter table shipment_boxes enable row level security;

-- ─── Bridge Jobs ──────────────────────────────────────────────────────────────
-- Durable queue between the web app and the local Folia Bridge that drives
-- the Palmstreet Android app via ADB. Web enqueues, bridge polls outbound.

create table if not exists bridge_jobs (
  id            text        primary key,
  status        text        not null default 'queued'
                              check (status in ('queued','running','done','failed')),
  action        text        not null,
  payload       jsonb       not null default '{}'::jsonb,
  result        jsonb,
  error         text,
  "createdAt"   timestamptz not null default now(),
  "createdBy"   text,
  "claimedAt"   timestamptz,
  "claimedBy"   text,
  "completedAt" timestamptz
);
create index if not exists bridge_jobs_pending_idx
  on bridge_jobs (status, "createdAt")
  where status in ('queued','running');

alter table bridge_jobs enable row level security;

-- ─── Row-Level Security ───────────────────────────────────────────────────────
-- All data access goes through the server-side API routes (under /api),
-- which use the service_role key that bypasses RLS. The anon key is no
-- longer used by this app, so no policies are granted to `anon`. RLS is
-- still enabled as defense-in-depth in case the anon key ever leaks.

alter table users           enable row level security;
alter table inventory_items enable row level security;
alter table sales           enable row level security;
alter table varieties       enable row level security;
alter table species         enable row level security;

-- Drop the old permissive policies if they exist (safe to re-run).
drop policy if exists "allow_all" on users;
drop policy if exists "allow_all" on inventory_items;
drop policy if exists "allow_all" on sales;
drop policy if exists "anon_all" on users;
drop policy if exists "anon_all" on inventory_items;
drop policy if exists "anon_all" on sales;

-- ─── Functions ────────────────────────────────────────────────────────────────
-- Largest numeric SKU suffix across all inventory items. Used by the
-- /api/items insert path to assign the next global SKU number. Doing this
-- in SQL avoids the lex-sort bug that the JS-side `order().limit()`
-- approach had with mixed-width prefixes/suffixes.
create or replace function inventory_max_sku_suffix() returns int
language sql stable as $$
  select coalesce(
    max((regexp_match(sku, '-(\d+)$'))[1]::int),
    0
  )
  from inventory_items
  where sku ~ '-\d+$';
$$;

-- Per-sale-event "Evaluate Sales" report snapshot (read-only; see migration
-- 0027). One row per sale; re-evaluating upserts. Whole result object as jsonb.
create table if not exists sale_evaluations (
  "saleId"    text        primary key references sales(id) on delete cascade,
  result      jsonb       not null,
  "updatedAt" timestamptz not null default now(),
  "updatedBy" text
);

-- ─── 3babes multi-brand (migration 0029) ───────────────────────────────────────
-- One database runs multiple brands (Folia, BAE). Each brand-scoped row carries
-- a brandId; users carry a brandIds access list. Kept as idempotent ALTERs at
-- the end so the create-table blocks above stay the historical single-tenant
-- shape. Full plan: docs/3babes-multi-brand.md.
create table if not exists brands (
  id          text        primary key,
  slug        text        unique not null,
  name        text        not null,
  "createdAt" timestamptz not null default now()
);
insert into brands (id, slug, name) values
  ('folia', 'folia', 'Folia'),
  ('bae',   'bae',   'BAE — Best Anthuriums Ever')
on conflict (id) do nothing;

alter table inventory_items add column if not exists "brandId" text references brands(id);
alter table sales add column if not exists "brandId" text references brands(id);
alter table varieties add column if not exists "brandId" text references brands(id);
alter table species add column if not exists "brandId" text references brands(id);
alter table species_photos add column if not exists "brandId" text references brands(id);
alter table purchase_orders add column if not exists "brandId" text references brands(id);
alter table purchase_order_lines add column if not exists "brandId" text references brands(id);
alter table purchase_order_received_items add column if not exists "brandId" text references brands(id);
alter table shipments add column if not exists "brandId" text references brands(id);
alter table shipment_boxes add column if not exists "brandId" text references brands(id);
alter table bridge_jobs add column if not exists "brandId" text references brands(id);
alter table sale_evaluations add column if not exists "brandId" text references brands(id);
alter table item_photos add column if not exists "brandId" text references brands(id);
alter table app_settings add column if not exists "brandId" text references brands(id);
alter table users add column if not exists "brandIds" text[] not null default array['folia']::text[];

-- SKU numbering + uniqueness are per-brand (migration 0030): each brand has its
-- own SKU sequence and prefixes, so the unique constraint is (brandId, sku) and
-- the max-suffix RPC takes a brand. Brand-scoped variant lives alongside the
-- original no-arg function (kept for any legacy caller).
drop index if exists inventory_items_sku_unique;
create unique index if not exists inventory_items_sku_brand_unique
  on inventory_items ("brandId", sku);

create or replace function inventory_max_sku_suffix(p_brand text) returns int
language sql stable as $$
  select coalesce(
    max((regexp_match(sku, '-(\d+)$'))[1]::int),
    0
  )
  from inventory_items
  where "brandId" = p_brand and sku ~ '-\d+$';
$$;

-- ─── Seller consignment (migration 0033) ─────────────────────────────────────
-- Reusable per-brand sellers whose plants BAE sells on consignment. `code` is
-- the SKU prefix segment (SKUs become <SELLERCODE>-<VARIETYCODE>-<n>), unique
-- per brand. Per-item sellerId/commissionPct tag the consigned plants.
create table if not exists sellers (
  id                     text        primary key,
  "brandId"              text        not null references brands(id),
  name                   text        not null,
  code                   text        not null,
  "defaultCommissionPct" numeric,
  username               text,
  contact                text,
  "createdAt"            timestamptz not null default now(),
  "createdBy"            text,
  "modifiedAt"           timestamptz,
  "modifiedBy"           text
);
create unique index if not exists sellers_brand_code_unique on sellers ("brandId", upper(code));
create index if not exists sellers_brand_idx on sellers ("brandId");
alter table sellers enable row level security;

alter table inventory_items add column if not exists "sellerId" text references sellers(id);
alter table inventory_items add column if not exists "commissionPct" numeric;
create index if not exists inventory_items_seller_idx
  on inventory_items ("brandId", "sellerId") where "sellerId" is not null;

-- ─── BAE loyalty: badges + punch-card rewards (migration 0034) ───────────────
-- Customer-facing loyalty loop for the BAE mobile app (separate Expo repo).
-- UNLIKE staff tables, the customer tables carry real RLS policies for the
-- Supabase Auth `authenticated` role — the app talks to Supabase directly.
-- redemption_codes stays policy-less (codes must not be enumerable); claims
-- go through the SECURITY DEFINER claim_redemption_code() RPC.
create table if not exists customers (
  id            uuid        primary key references auth.users(id) on delete cascade,
  "brandId"     text        not null default 'bae' references brands(id),
  "displayName" text,
  email         text,
  phone         text,
  "createdAt"   timestamptz not null default now()
);
alter table customers enable row level security;
drop policy if exists customers_select_own on customers;
create policy customers_select_own on customers
  for select to authenticated using (id = auth.uid());
drop policy if exists customers_insert_own on customers;
create policy customers_insert_own on customers
  for insert to authenticated with check (id = auth.uid());
drop policy if exists customers_update_own on customers;
create policy customers_update_own on customers
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create table if not exists redemption_codes (
  id              text        primary key,
  code            text        not null,
  "qrPayload"     text        not null,
  "shipmentBoxId" text        not null,
  "brandId"       text        not null references brands(id),
  "badgeCount"    integer     not null check ("badgeCount" > 0),
  status          text        not null default 'unclaimed' check (status in ('unclaimed','claimed')),
  "claimedBy"     uuid        references customers(id) on delete set null,
  "claimedAt"     timestamptz,
  "createdAt"     timestamptz not null default now(),
  "createdBy"     text
);
create unique index if not exists redemption_codes_code_unique
  on redemption_codes (upper(code));
create unique index if not exists redemption_codes_box_unique
  on redemption_codes ("shipmentBoxId");
create index if not exists redemption_codes_claimedby_idx
  on redemption_codes ("claimedBy") where "claimedBy" is not null;
alter table redemption_codes enable row level security;

create table if not exists badge_events (
  id             text        primary key,
  "customerId"   uuid        not null references customers(id) on delete cascade,
  "sourceCodeId" text        not null references redemption_codes(id),
  "plantRef"     text,
  "brandId"      text        not null references brands(id),
  "createdAt"    timestamptz not null default now()
);
create index if not exists badge_events_customer_idx
  on badge_events ("customerId", "brandId");
alter table badge_events enable row level security;
drop policy if exists badge_events_select_own on badge_events;
create policy badge_events_select_own on badge_events
  for select to authenticated using ("customerId" = auth.uid());

create table if not exists reward_config (
  "brandId"      text        primary key references brands(id),
  threshold      integer     not null check (threshold > 0),
  "rewardTitle"  text        not null,
  "rewardDetail" text,
  active         boolean     not null default true,
  "updatedAt"    timestamptz not null default now(),
  "updatedBy"    text
);
alter table reward_config enable row level security;
drop policy if exists reward_config_select_all on reward_config;
create policy reward_config_select_all on reward_config
  for select to authenticated using (true);
insert into reward_config ("brandId", threshold, "rewardTitle", "rewardDetail")
  values ('bae', 10, 'Free BAE anthurium', 'Collect 10 badges and get a free collectible anthurium on your next order. Show this reward code to staff to redeem.')
  on conflict ("brandId") do nothing;

create table if not exists reward_redemptions (
  id             text        primary key,
  "customerId"   uuid        not null references customers(id) on delete cascade,
  "brandId"      text        not null references brands(id),
  "thresholdMet" integer     not null,
  status         text        not null default 'pending' check (status in ('pending','fulfilled')),
  code           text        not null,
  "createdAt"    timestamptz not null default now(),
  "fulfilledAt"  timestamptz,
  "fulfilledBy"  text
);
create index if not exists reward_redemptions_customer_idx
  on reward_redemptions ("customerId");
create index if not exists reward_redemptions_brand_status_idx
  on reward_redemptions ("brandId", status);
alter table reward_redemptions enable row level security;
drop policy if exists reward_redemptions_select_own on reward_redemptions;
create policy reward_redemptions_select_own on reward_redemptions
  for select to authenticated using ("customerId" = auth.uid());

-- Atomic claim: validate → claim → grant badges → create newly-unlocked
-- rewards. Mirrors migration 0034 exactly — see there for the full rationale.
create or replace function claim_redemption_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_norm     text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  v_code     redemption_codes%rowtype;
  v_config   reward_config%rowtype;
  v_before   integer;
  v_total    integer;
  v_unlocked jsonb := '[]'::jsonb;
  v_rid      text;
  v_rcode    text;
  i          integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select * into v_code from redemption_codes where upper(code) = v_norm for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;
  if v_code.status <> 'unclaimed' then
    return jsonb_build_object('ok', false,
      'error', case when v_code."claimedBy" = v_uid then 'already_claimed_by_you' else 'already_claimed' end);
  end if;

  insert into customers (id, "brandId", email)
    values (v_uid, v_code."brandId", (select u.email from auth.users u where u.id = v_uid))
    on conflict (id) do nothing;
  perform 1 from customers where id = v_uid for update;

  select count(*) into v_before from badge_events
    where "customerId" = v_uid and "brandId" = v_code."brandId";

  update redemption_codes
    set status = 'claimed', "claimedBy" = v_uid, "claimedAt" = now()
    where id = v_code.id;

  for i in 1 .. v_code."badgeCount" loop
    insert into badge_events (id, "customerId", "sourceCodeId", "brandId")
      values ('be_' || replace(gen_random_uuid()::text, '-', ''), v_uid, v_code.id, v_code."brandId");
  end loop;

  v_total := v_before + v_code."badgeCount";

  select * into v_config from reward_config
    where "brandId" = v_code."brandId" and active;
  if found then
    for i in (v_before / v_config.threshold) + 1 .. (v_total / v_config.threshold) loop
      v_rid   := 'rr_' || replace(gen_random_uuid()::text, '-', '');
      v_rcode := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      insert into reward_redemptions (id, "customerId", "brandId", "thresholdMet", code)
        values (v_rid, v_uid, v_code."brandId", i * v_config.threshold, v_rcode);
      v_unlocked := v_unlocked || jsonb_build_object(
        'id', v_rid, 'code', v_rcode, 'thresholdMet', i * v_config.threshold,
        'rewardTitle', v_config."rewardTitle", 'rewardDetail', v_config."rewardDetail");
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'granted', v_code."badgeCount",
    'totalBadges', v_total,
    'threshold', case when v_config."brandId" is null then null else v_config.threshold end,
    'unlocked', v_unlocked);
end
$$;

revoke all on function claim_redemption_code(text) from public;
revoke all on function claim_redemption_code(text) from anon;
grant execute on function claim_redemption_code(text) to authenticated;
grant execute on function claim_redemption_code(text) to service_role;
