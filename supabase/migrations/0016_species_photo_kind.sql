-- 0016 · species_photos.kind — distinguishes the gallery photos from the
-- per-species parent-plant slots (mother / father), used today for
-- Anthurium cultivars where breeders care about parentage.
--
-- 'gallery' = ordered, multi-photo gallery on a catalog card (existing behavior)
-- 'mother'  = single-slot mother plant photo (replaceable)
-- 'father'  = single-slot father plant photo (replaceable)
--
-- Idempotent. Existing rows default to 'gallery', matching prior behavior.

alter table species_photos
  add column if not exists "kind" text not null default 'gallery';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'species_photos_kind_check') then
    alter table species_photos
      add constraint species_photos_kind_check
      check ("kind" in ('gallery','mother','father'));
  end if;
end $$;

create index if not exists species_photos_species_kind_idx
  on species_photos ("speciesId", "kind");

insert into applied_migrations (id) values ('0016_species_photo_kind')
  on conflict (id) do nothing;
