-- 0019 · Per-item photos
--
-- Until now photos lived only on the species/catalog row (species_photos),
-- so every item of a cultivar shared the same gallery. The Pre Sale tab
-- needs per-individual-item photos (the actual plant going up for sale),
-- so this adds an item-scoped photo table mirroring species_photos.
--
-- Storage reuses the existing 'plant-photos' bucket. Path convention:
--   items/<itemId>/<photoId>.<ext>
-- (species photos use `<speciesId>/<photoId>.<ext>`, so the `items/`
-- prefix keeps the two namespaces from ever colliding.)

create table if not exists item_photos (
  id            text        primary key,
  "itemId"      text        not null references inventory_items(id) on delete cascade,
  "storagePath" text        not null,
  "sortOrder"   integer     not null default 0,
  "createdAt"   timestamptz not null default now(),
  "createdBy"   text
);
create index if not exists item_photos_item_idx
  on item_photos ("itemId", "sortOrder");

alter table item_photos enable row level security;
