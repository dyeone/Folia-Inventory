-- Cross-brand stock sharing: a plant can be MOVED between the brands a user
-- can access (bae-gin ⇄ BAE), so either brand can sell the other's stock.
-- The brand invariant stays intact — a plant belongs to exactly one brand at
-- a time and every query keeps its brandId filter; this ledger records each
-- move so the sending brand's books can settle with the receiving one.
--
-- Apply by hand in the Supabase SQL editor (like every migration here).
-- Until it is applied, POST /api/items action=transfer fails with a clear
-- message and nothing moves.

create table if not exists item_transfers (
  id              text        primary key,          -- client transferId → idempotent retries
  "itemId"        text        not null references inventory_items(id) on delete cascade,
  "fromBrandId"   text        not null references brands(id),
  "toBrandId"     text        not null references brands(id),
  "fromSku"       text        not null,
  "toSku"         text        not null,             -- same as fromSku unless the receiving brand already used it
  "fromSpeciesId" text,
  "toSpeciesId"   text,
  "grossCost"     numeric,                           -- the plant's cost at the moment it moved
  "netCost"       numeric,
  reason          text        not null default 'manual'
                    check (reason in ('sale', 'manual', 'return')),
  "saleId"        text,                              -- the receiving brand's sale it moved for (reason = sale)
  "createdAt"     timestamptz not null default now(),
  "createdBy"     text
);
create index if not exists item_transfers_item_idx on item_transfers ("itemId", "createdAt" desc);
create index if not exists item_transfers_to_idx   on item_transfers ("toBrandId", "createdAt" desc);
create index if not exists item_transfers_from_idx on item_transfers ("fromBrandId", "createdAt" desc);
alter table item_transfers enable row level security;

insert into applied_migrations (id) values ('0046_item_transfers')
  on conflict (id) do nothing;
