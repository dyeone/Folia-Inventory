-- One SKU number sequence for every brand.
--
-- Until now each brand numbered its own SKUs (migration 0030), so bae-gin and
-- BAE both minted ANT-8190 and the like. Now that plants move between the
-- brands (0046) a label must mean ONE plant wherever it is scanned, so new
-- SKUs come from the max over ALL brands (api/items.js findMaxSkuSuffix,
-- api/purchase-orders.js receive). This index makes the database enforce it
-- for every row minted from here on — two brands minting at the same moment
-- can no longer both win the same number. Rows from the per-brand era keep
-- their SKUs (the per-brand unique index from 0030 still covers them); the
-- in-stock duplicates between the brands are cleaned up from the app
-- ("Other brand stock" → renumber & reprint).
--
-- Apply by hand in the Supabase SQL editor.

create unique index if not exists inventory_items_sku_global_unique
  on inventory_items (sku)
  where "createdAt" >= '2026-10-02 00:00:00+00'::timestamptz;

insert into applied_migrations (id) values ('0047_sku_shared_sequence')
  on conflict (id) do nothing;
