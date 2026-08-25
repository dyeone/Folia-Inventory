-- 0041 · Retire the Folia brand, add bae-gin.
--
-- Folia (the original brand) is removed from the app: bae-gin takes its
-- place as the default brand, wired identically (brand switcher, palette,
-- labels, default access). Folia's DATA IS NOT DELETED — the brands row and
-- every brandId='folia' record (inventory, sales, species, POs, shipments)
-- stay archived in the database, and its brand row remains because those
-- rows FK-reference it. No user keeps 'folia' in brandIds after this runs,
-- so nothing surfaces in the app; re-granting 'folia' to a user would
-- un-archive it.
--
-- Pairs with the frontend/API change of DEFAULT_BRAND 'folia' → 'bae-gin'.
-- bae-gin starts EMPTY — no data is moved onto it. Idempotent.

insert into brands (id, slug, name) values
  ('bae-gin', 'bae-gin', 'bae-gin')
on conflict (id) do nothing;

-- Swap brand access: everyone who could see Folia now sees bae-gin instead.
update users
  set "brandIds" = array_replace("brandIds", 'folia', 'bae-gin')
  where 'folia' = any("brandIds");

-- New users default to the new default brand.
alter table users alter column "brandIds" set default array['bae-gin']::text[];

insert into applied_migrations (id) values ('0041_baegin_brand')
  on conflict (id) do nothing;
