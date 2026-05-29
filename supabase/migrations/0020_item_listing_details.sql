-- 0020 · Per-item Palmstreet listing details
--
-- Holds the editable, listing-specific fields the operator fills in on the
-- Pre Sale tab before exporting a sale's lineup to Palmstreet's CSV template:
--   { title, description, variations: [{name,value} x3], private, shipping }
-- Price, quantity, image URL and SKU keep living in their own columns
-- (listingPrice / quantity / imageUrl / sku) so the rest of the app stays
-- consistent; this blob only carries the Palmstreet-only extras.

alter table inventory_items
  add column if not exists "listingDetails" jsonb not null default '{}'::jsonb;
