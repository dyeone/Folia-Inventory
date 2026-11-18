-- 0052 · For Sale tab: product pools, short plant codes, one video per plant,
-- Shopify sync state.
--
-- saleCode     the plant's short code ("KM42": two letters, two digits —
--              no I/O/Q so it can't be misread). Printed big on its tag and
--              put in every listing title, so a packer holding an order can
--              find the pot on the bench. Unique per brand, never reused.
-- salePool     which product pool the plant sells from: 'palmstreet' (the
--              CSV upload) or 'shopify' (synced by the app). Null = not in
--              the For Sale tab.
-- poolAddedAt  when it joined its pool (the tab sorts newest first).
-- videoUrl     public URL of its one listing video (plant-videos bucket);
--              its one photo stays in item_photos / imageUrl as before.
-- shopify      sync state for the Shopify pool: product / variant /
--              inventory ids, last synced listing fingerprint, last error.
--
-- Also creates the public `plant-videos` bucket (50 MB per file, video
-- types only); photos keep using `plant-photos`.
--
-- Idempotent. Apply by hand in the Supabase SQL editor.

alter table inventory_items add column if not exists "saleCode" text;
alter table inventory_items add column if not exists "salePool" text;
alter table inventory_items add column if not exists "poolAddedAt" timestamptz;
alter table inventory_items add column if not exists "videoUrl" text;
alter table inventory_items add column if not exists "shopify" jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_sale_pool_check') then
    alter table inventory_items add constraint inventory_items_sale_pool_check
      check ("salePool" is null or "salePool" in ('palmstreet', 'shopify'));
  end if;
end $$;

create unique index if not exists inventory_items_brand_sale_code
  on inventory_items ("brandId", "saleCode") where "saleCode" is not null;
create index if not exists inventory_items_brand_sale_pool
  on inventory_items ("brandId", "salePool") where "salePool" is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plant-videos', 'plant-videos', true, 52428800,
        array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into applied_migrations (id) values ('0052_for_sale_pools')
  on conflict (id) do nothing;
