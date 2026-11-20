-- 0055 · Several videos and a staff note per plant (For Sale tab, 2026-11-20).
--
-- videoUrls  every video of the plant, in the order they were added, as
--            public URLs (bucket plant-videos, items/<id>/…). Kept by the
--            server on every video add / delete (api/species-photos.js);
--            videoUrl stays the first one, so everything that shows "has a
--            video" keeps reading it. The Palmstreet CSV and the Shopify
--            sync put every video up, after the photos.
-- staffNote  a note on the plant for the team, written on its For Sale
--            sheet. Never exported: not in the Palmstreet CSV, not on the
--            website (the plant's `notes` go in Palmstreet descriptions,
--            so they can't hold this).
--
-- The backfill starts each plant's list with the video it already has.
--
-- Idempotent. Apply by hand in the Supabase SQL editor.

alter table inventory_items add column if not exists "videoUrls" jsonb;
alter table inventory_items add column if not exists "staffNote" text;

update inventory_items
set "videoUrls" = jsonb_build_array("videoUrl")
where "videoUrls" is null and "videoUrl" is not null;

insert into applied_migrations (id) values ('0055_plant_videos_notes')
  on conflict (id) do nothing;
