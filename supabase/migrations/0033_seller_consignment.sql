-- 0033 · Seller consignment (BAE).
--
-- BAE sells other people's plants on consignment: at a sale event the operator
-- creates a "seller section", intakes that seller's plants INTO our inventory
-- at an agreed commission %, and later settles up (we keep the commission, the
-- seller gets the rest). This is the INVERSE of the 0032 'consigned' status
-- (which is us handing OUR plant to someone else) — do not conflate the two.
-- Consignment-intake plants live the normal available→sold lifecycle; the new
-- inventory_items."sellerId" is the only extra signal.
--
-- Sellers are reusable per brand (a seller returns for multiple events), so they
-- get their own table rather than living inside one event. `code` is the SKU
-- prefix segment (SKUs become <SELLERCODE>-<VARIETYCODE>-<n>, e.g. JADE-ANT-142)
-- so it is unique per brand and constrained to 2–8 letters (fits the Palmstreet
-- SKU regex prefix class and CODE128).
--
-- Depends on 0029 (brands) + 0030 (per-brand sku uniqueness). Idempotent.

create table if not exists sellers (
  id                     text        primary key,
  "brandId"              text        not null references brands(id),
  name                   text        not null,
  code                   text        not null,   -- SKU prefix segment, 2–8 letters
  "defaultCommissionPct" numeric,                -- % WE keep on this seller's plants
  username               text,                   -- optional @handle
  contact                text,                   -- optional phone/email/notes
  "createdAt"            timestamptz not null default now(),
  "createdBy"            text,
  "modifiedAt"           timestamptz,
  "modifiedBy"           text
);

-- code is SKU-load-bearing → unique per brand (case-insensitive). Also index the fk.
create unique index if not exists sellers_brand_code_unique on sellers ("brandId", upper(code));
create index if not exists sellers_brand_idx on sellers ("brandId");

-- Scoping is enforced in the API (service-role key bypasses RLS); enabling RLS
-- with no policies keeps the anon key from ever reading sellers, matching
-- item_photos (0019).
alter table sellers enable row level security;

-- Per-item seller tag + commission. commissionPct is the effective rate written
-- at intake (seller default or per-plant override) so downstream P&L / settlement
-- never needs to re-resolve the seller default.
alter table inventory_items add column if not exists "sellerId" text references sellers(id);
alter table inventory_items add column if not exists "commissionPct" numeric;
create index if not exists inventory_items_seller_idx
  on inventory_items ("brandId", "sellerId") where "sellerId" is not null;

insert into applied_migrations (id) values ('0033_seller_consignment')
  on conflict (id) do nothing;
