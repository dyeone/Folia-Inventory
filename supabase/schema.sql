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

-- Allow 'refunded' as a status (full refunds get marked here; partials keep
-- their existing sold/shipped status with refundedAmount > 0).
alter table inventory_items drop constraint if exists inventory_items_status_check;
alter table inventory_items add constraint inventory_items_status_check
  check (status in ('available','listed','sold','shipped','delivered','converted','refunded'));

-- ─── Constraints ──────────────────────────────────────────────────────────────
-- Enforce SKU uniqueness across all inventory items. Using a unique index
-- with IF NOT EXISTS so this is safe to re-run. If existing rows already
-- contain duplicate SKUs, this statement will fail — resolve the duplicates
-- first, then re-run.
create unique index if not exists inventory_items_sku_unique
  on inventory_items (sku);

-- ─── Row-Level Security ───────────────────────────────────────────────────────
-- All data access goes through the server-side API routes (under /api),
-- which use the service_role key that bypasses RLS. The anon key is no
-- longer used by this app, so no policies are granted to `anon`. RLS is
-- still enabled as defense-in-depth in case the anon key ever leaks.

alter table users           enable row level security;
alter table inventory_items enable row level security;
alter table sales           enable row level security;

-- Drop the old permissive policies if they exist (safe to re-run).
drop policy if exists "allow_all" on users;
drop policy if exists "allow_all" on inventory_items;
drop policy if exists "allow_all" on sales;
drop policy if exists "anon_all" on users;
drop policy if exists "anon_all" on inventory_items;
drop policy if exists "anon_all" on sales;
