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
