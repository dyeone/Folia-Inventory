-- 0053 · Several photos per plant (For Sale tab).
--
-- photoUrls  every photo of the plant, in gallery order (cover first), as
--            public URLs. A copy of item_photos kept by the server whenever a
--            photo is added, deleted or moved (api/_lib/itemPhotos.js), so the
--            Palmstreet CSV (all photos + the video in the Image URL cell) and
--            the Shopify sync (every photo on the product) read it straight
--            off the plant. imageUrl stays the cover photo, as before.
--
-- The backfill fills it for plants that already have photos. The public URL
-- prefix is taken from a stored photo URL (this project's Supabase address),
-- so the file holds nothing project-specific.
--
-- Idempotent. Apply by hand in the Supabase SQL editor.

alter table inventory_items add column if not exists "photoUrls" jsonb;

with base as (
  select split_part("imageUrl", '/storage/v1/object/public/plant-photos/', 1) as url
  from inventory_items
  where "imageUrl" like 'http%/storage/v1/object/public/plant-photos/items/%'
  limit 1
)
update inventory_items i
set "photoUrls" = (
  select jsonb_agg(base.url || '/storage/v1/object/public/plant-photos/' || p."storagePath"
                   order by p."sortOrder", p."createdAt")
  from item_photos p
  where p."itemId" = i.id
)
from base
where i."photoUrls" is null
  and exists (select 1 from item_photos p where p."itemId" = i.id);

insert into applied_migrations (id) values ('0053_plant_photo_urls')
  on conflict (id) do nothing;
