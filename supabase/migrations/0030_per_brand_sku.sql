-- 0030 · Per-brand SKU numbering + uniqueness.
--
-- SKUs were globally unique with one global number sequence
-- (inventory_max_sku_suffix()). With multiple brands each brand needs its own
-- sequence and its own variety prefixes, and two brands may legitimately both
-- have e.g. "ANT-1". So:
--   * uniqueness becomes (brandId, sku) instead of (sku)
--   * the max-suffix RPC takes a brand argument
--
-- Depends on 0029 (brandId already present + backfilled on inventory_items).
-- Idempotent.

-- Per-brand uniqueness. Drop the global index, add the composite. Safe because
-- 0029 backfilled every existing row to 'folia', so no (brandId, sku) collisions
-- can exist that didn't already exist as (sku) collisions.
drop index if exists inventory_items_sku_unique;
create unique index if not exists inventory_items_sku_brand_unique
  on inventory_items ("brandId", sku);

-- Brand-scoped max suffix. Overloads (does not replace) the original no-arg
-- function so any legacy caller keeps working during the rollout.
create or replace function inventory_max_sku_suffix(p_brand text) returns int
language sql stable as $$
  select coalesce(
    max((regexp_match(sku, '-(\d+)$'))[1]::int),
    0
  )
  from inventory_items
  where "brandId" = p_brand and sku ~ '-\d+$';
$$;

insert into applied_migrations (id) values ('0030_per_brand_sku')
  on conflict (id) do nothing;
