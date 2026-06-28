-- 0029 · 3babes multi-brand foundation.
--
-- Turns single-tenant Folia into a multi-brand house (3babes) running Folia +
-- BAE from one database. Adds a `brands` table, a `brandId` on every
-- brand-scoped table (backfilled to the existing Folia data), a `brandIds`
-- access list on users, and a nullable `brandId` on app_settings.
--
-- Purely additive and idempotent. After this runs, NOTHING in the app sends a
-- brand yet, so Folia behaves exactly as before — the API defaults everything
-- to the 'folia' brand until the brand switcher ships (Stage 3).
--
-- See docs/3babes-multi-brand.md for the full plan.

-- ── The brands (3babes is the app itself; one company, so no companies table) ──
create table if not exists brands (
  id text primary key,
  slug text unique not null,
  name text not null,
  "createdAt" timestamptz not null default now()
);

insert into brands (id, slug, name) values
  ('folia', 'folia', 'Folia'),
  ('bae',   'bae',   'BAE — Best Anthuriums Ever')
on conflict (id) do nothing;

-- ── Brand-scoped tables: add brandId, backfill to folia, lock NOT NULL, index ──
-- Done one block per table (rather than a DO loop) so each statement is plainly
-- visible and individually idempotent.

-- inventory_items
alter table inventory_items add column if not exists "brandId" text references brands(id);
update inventory_items set "brandId" = 'folia' where "brandId" is null;
alter table inventory_items alter column "brandId" set not null;
create index if not exists inventory_items_brand_idx on inventory_items("brandId");

-- sales
alter table sales add column if not exists "brandId" text references brands(id);
update sales set "brandId" = 'folia' where "brandId" is null;
alter table sales alter column "brandId" set not null;
create index if not exists sales_brand_idx on sales("brandId");

-- varieties (variety codes / SKU prefixes are per brand)
alter table varieties add column if not exists "brandId" text references brands(id);
update varieties set "brandId" = 'folia' where "brandId" is null;
alter table varieties alter column "brandId" set not null;
create index if not exists varieties_brand_idx on varieties("brandId");

-- species
alter table species add column if not exists "brandId" text references brands(id);
update species set "brandId" = 'folia' where "brandId" is null;
alter table species alter column "brandId" set not null;
create index if not exists species_brand_idx on species("brandId");

-- species_photos
alter table species_photos add column if not exists "brandId" text references brands(id);
update species_photos set "brandId" = 'folia' where "brandId" is null;
alter table species_photos alter column "brandId" set not null;
create index if not exists species_photos_brand_idx on species_photos("brandId");

-- purchase_orders
alter table purchase_orders add column if not exists "brandId" text references brands(id);
update purchase_orders set "brandId" = 'folia' where "brandId" is null;
alter table purchase_orders alter column "brandId" set not null;
create index if not exists purchase_orders_brand_idx on purchase_orders("brandId");

-- purchase_order_lines (denormalized brandId from parent for simple scoping)
alter table purchase_order_lines add column if not exists "brandId" text references brands(id);
update purchase_order_lines set "brandId" = 'folia' where "brandId" is null;
alter table purchase_order_lines alter column "brandId" set not null;
create index if not exists purchase_order_lines_brand_idx on purchase_order_lines("brandId");

-- purchase_order_received_items
alter table purchase_order_received_items add column if not exists "brandId" text references brands(id);
update purchase_order_received_items set "brandId" = 'folia' where "brandId" is null;
alter table purchase_order_received_items alter column "brandId" set not null;
create index if not exists purchase_order_received_items_brand_idx on purchase_order_received_items("brandId");

-- shipments
alter table shipments add column if not exists "brandId" text references brands(id);
update shipments set "brandId" = 'folia' where "brandId" is null;
alter table shipments alter column "brandId" set not null;
create index if not exists shipments_brand_idx on shipments("brandId");

-- shipment_boxes
alter table shipment_boxes add column if not exists "brandId" text references brands(id);
update shipment_boxes set "brandId" = 'folia' where "brandId" is null;
alter table shipment_boxes alter column "brandId" set not null;
create index if not exists shipment_boxes_brand_idx on shipment_boxes("brandId");

-- bridge_jobs
alter table bridge_jobs add column if not exists "brandId" text references brands(id);
update bridge_jobs set "brandId" = 'folia' where "brandId" is null;
alter table bridge_jobs alter column "brandId" set not null;
create index if not exists bridge_jobs_brand_idx on bridge_jobs("brandId");

-- sale_evaluations
alter table sale_evaluations add column if not exists "brandId" text references brands(id);
update sale_evaluations set "brandId" = 'folia' where "brandId" is null;
alter table sale_evaluations alter column "brandId" set not null;
create index if not exists sale_evaluations_brand_idx on sale_evaluations("brandId");

-- item_photos (photos attached to inventory items; migration 0019)
alter table item_photos add column if not exists "brandId" text references brands(id);
update item_photos set "brandId" = 'folia' where "brandId" is null;
alter table item_photos alter column "brandId" set not null;
create index if not exists item_photos_brand_idx on item_photos("brandId");

-- ── app_settings: nullable brandId (NULL = global, e.g. ShipStation config;
--    a brand id = per-brand, e.g. the box-size catalog). The settings endpoint
--    decides per key, so we do NOT backfill or lock NOT NULL here. ──
alter table app_settings add column if not exists "brandId" text references brands(id);
create index if not exists app_settings_brand_idx on app_settings("brandId");

-- ── users: per-user brand access list. Everyone today is a Folia user. ──
alter table users add column if not exists "brandIds" text[] not null default array['folia']::text[];

-- Grant the 3babes owner access to all brands. Adjust the username, then
-- uncomment and run (left commented so we never guess the wrong account):
-- update users set "brandIds" = array['folia','bae'] where username = 'YOUR_OWNER_USERNAME';

insert into applied_migrations (id) values ('0029_multi_brand_foundation')
  on conflict (id) do nothing;
