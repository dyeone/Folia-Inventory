-- 0007 · Postgres function to return the largest numeric suffix across all
-- inventory SKUs. SKUs look like `ALO-247`, `JWL-1003`, etc. The previous
-- JS implementation tried to fake this with `order by sku desc limit 256`,
-- but that's a *lexicographic* sort — `MON-99` sorts above `ANT-2000`, so
-- the top-256 window can completely miss the true max suffix and assign a
-- duplicate number under a different variety prefix.
--
-- Doing it in SQL is one round-trip and uses the actual integer ordering.
--
-- Idempotent.

create or replace function inventory_max_sku_suffix() returns int
language sql stable as $$
  select coalesce(
    max((regexp_match(sku, '-(\d+)$'))[1]::int),
    0
  )
  from inventory_items
  where sku ~ '-\d+$';
$$;

insert into applied_migrations (id) values ('0007_max_sku_suffix_rpc')
  on conflict (id) do nothing;
