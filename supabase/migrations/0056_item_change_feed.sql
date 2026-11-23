-- 0056 · Read only what changed: a change feed for the plant list (2026-11-23).
--
-- Every open Shipping tab and every packer device re-read the WHOLE plant
-- list every 8 s (~7,000 rows / ~9 MB per brand, ~18 queries a poll). On the
-- Nano database that ran the disk-read budget dry and the database stopped
-- answering (2026-11-21, 11-22, 11-23). With this, a poll asks for the rows
-- changed since its last one (GET /api/items?since=…), usually none.
--
-- changedAt   stamped by the database on every insert and update — never by
--             the app, so no write path can forget it (modifiedAt stays the
--             "last edited by a person" time the item sheet shows).
-- inventory_item_tombstones
--             one row per plant that LEFT a brand's list: deleted for good
--             (trash purge, placeholder clean-ups) or moved to the other
--             brand (cross-brand transfer). A change feed can't see a row
--             that is gone, so it reads these. Rows older than a day are
--             purged by the API (a client that has been away that long
--             reloads everything).
--
-- Before this runs, the API falls back to the full read, so the app works
-- either way. Idempotent. Apply by hand in the Supabase SQL editor.

-- A constant default: existing rows all get the time this runs, without
-- rewriting the table.
alter table inventory_items add column if not exists "changedAt" timestamptz not null default now();
create index if not exists inventory_items_brand_changed
  on inventory_items ("brandId", "changedAt");

create table if not exists inventory_item_tombstones (
  "itemId"   text        not null,
  "brandId"  text        not null,
  "goneAt"   timestamptz not null default clock_timestamp()
);
create index if not exists inventory_item_tombstones_brand_gone
  on inventory_item_tombstones ("brandId", "goneAt");
alter table inventory_item_tombstones enable row level security;

-- clock_timestamp(), not now(): now() is the start of the transaction, and
-- the API reads the feed with a 2-minute overlap for exactly that gap.
create or replace function inventory_items_touch_changed() returns trigger
language plpgsql as $$
begin
  new."changedAt" := clock_timestamp();
  if tg_op = 'UPDATE' and old."brandId" is distinct from new."brandId" then
    insert into inventory_item_tombstones ("itemId", "brandId") values (old.id, old."brandId");
  end if;
  return new;
end $$;

create or replace function inventory_items_tombstone() returns trigger
language plpgsql as $$
begin
  insert into inventory_item_tombstones ("itemId", "brandId") values (old.id, old."brandId");
  return old;
end $$;

drop trigger if exists inventory_items_touch_changed on inventory_items;
create trigger inventory_items_touch_changed
  before insert or update on inventory_items
  for each row execute function inventory_items_touch_changed();

drop trigger if exists inventory_items_tombstone on inventory_items;
create trigger inventory_items_tombstone
  after delete on inventory_items
  for each row execute function inventory_items_tombstone();

insert into applied_migrations (id) values ('0056_item_change_feed')
  on conflict (id) do nothing;
