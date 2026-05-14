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
  role          text        not null default 'staff' check (role in ('admin','staff')),
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
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_lotkind_check') then
    alter table inventory_items add constraint inventory_items_lotkind_check
      check ("lotKind" in ('sale','giveaway'));
  end if;
end $$;

-- Order-level details captured from the Palmstreet orders file (so we can
-- reconcile against the cashflow report by Order No), plus refund tracking
-- populated when the cashflow report is uploaded in the Financial tab.
alter table inventory_items add column if not exists "orderId" text;
alter table inventory_items add column if not exists "orderDate" timestamptz;
alter table inventory_items add column if not exists "refundedAmount" numeric default 0;
alter table inventory_items add column if not exists "refundedAt" timestamptz;
create index if not exists inventory_items_orderid_idx on inventory_items ("orderId");

-- Carrier the box should ship by ('usps' default, 'ups' if the buyer paid
-- for the "UPS 2-Day Upgrade" line item in their Palmstreet order). Set at
-- the item level rather than a separate shipments row so the Packing tab
-- can group by carrier without an extra join.
alter table inventory_items add column if not exists "shipmentCarrier" text default 'usps';
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

-- Allow 'refunded' as a status (full refunds get marked here; partials keep
-- their existing sold/shipped status with refundedAmount > 0).
alter table inventory_items drop constraint if exists inventory_items_status_check;
alter table inventory_items add constraint inventory_items_status_check
  check (status in ('available','listed','sold','shipped','delivered','converted','refunded'));

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
  "isTestLabel"            boolean     not null default false,
  "purchasedAt"            timestamptz not null default now(),
  "purchasedBy"            text,
  "voidedAt"               timestamptz,
  "voidedBy"               text
);
create index if not exists shipments_saleid_idx on shipments ("saleId");
create index if not exists shipments_carrier_idx on shipments (carrier);

alter table app_settings enable row level security;
alter table shipments    enable row level security;

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
