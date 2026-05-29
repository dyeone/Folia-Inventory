-- 0021 · Publish the plant-photos bucket
--
-- Item photos (and species photos) live in the `plant-photos` Storage bucket.
-- The Pre Sale flow now auto-fills each item's imageUrl — the Palmstreet CSV
-- "Image URL" column — from its primary photo, which means Palmstreet has to
-- be able to fetch that URL without a signed token. Make the bucket public.
--
-- Listing/catalog photos are product images that end up public on Palmstreet
-- anyway, so this exposes nothing sensitive. Signed URLs keep working too.
update storage.buckets set public = true where id = 'plant-photos';
