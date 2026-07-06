-- 0031 · Migrate Folia anthuriums (SKU > 4000, available only) to BAE.
--
-- One-off data migration. Moves 554 *available* Folia anthurium items whose
-- SKU suffix is > 4000 into the BAE brand, along with the taxonomy they need to
-- be valid BAE rows. Already-transacted items (shipped/sold) and their Folia
-- sale/shipment history are LEFT in Folia by design — history stays where it
-- happened. Anthuriums with SKU <= 4000 also stay in Folia.
--
-- Because the brands share no taxonomy (varieties + species are brand-scoped),
-- moving an item means giving BAE its own Anthurium variety + species rows and
-- re-pointing the items at them — otherwise a BAE item would reference Folia
-- taxonomy. We COPY species (not move): some of the 21 species are still used
-- by the Folia anthuriums that stay (SKU <= 4000, plus the shipped/sold ones),
-- so moving would orphan them.
--
-- Also fixes a latent multi-brand bug: varieties.name was GLOBALLY unique
-- (carried over from before 0029), which blocks any second brand from having a
-- variety named "Anthurium". Relaxed to unique per (brandId, name).
--
-- Media is intentionally NOT copied: BAE species start without species_photos /
-- imageUrl so the two brands never share image rows or storage files. The 554
-- items keep their own item_photos (moved with them).
--
-- No temp tables: each step re-runs the same Folia-anthurium predicate inline,
-- and the brand-flip is the LAST step, so every earlier step still sees the
-- same 554 items. Transactional + idempotent (re-running is a no-op once the
-- items are BAE). TAKE A DATABASE BACKUP / confirm PITR before applying. There
-- is no down migration; restore from backup to roll back.

begin;

-- ── 0. Relax the global varieties.name unique → per (brandId, name) ──────────
do $$
declare c text;
begin
  select con.conname into c
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'varieties' and con.contype = 'u'
    and array_length(con.conkey, 1) = 1
    and (select attname from pg_attribute
         where attrelid = con.conrelid and attnum = con.conkey[1]) = 'name';
  if c is not null then execute format('alter table varieties drop constraint %I', c); end if;
end $$;
create unique index if not exists varieties_brand_name_unique on varieties ("brandId", name);

-- ── 1. BAE Anthurium variety (code ANT) ─────────────────────────────────────
insert into varieties (id, name, code, "brandId", "createdBy")
values ('var_anthurium_bae', 'Anthurium', 'ANT', 'bae', 'migration-0031')
on conflict (id) do nothing;

-- ── 2. Copy the species used by the target items into BAE (catalog only) ────
insert into species (id, "varietyId", epithet, "commonName", notes,
                     "profitRate", "wholesalePrice", "idealSellingPrice",
                     "brandId", "createdBy")
select 'sp_bae_' || substr(md5('bae|' || s.id), 1, 16),
       'var_anthurium_bae', s.epithet, s."commonName", s.notes,
       s."profitRate", s."wholesalePrice", s."idealSellingPrice",
       'bae', 'migration-0031'
from species s
where s.id in (
  select distinct "speciesId" from inventory_items
  where "brandId" = 'folia' and lower(coalesce(variety, '')) = 'anthurium'
    and status = 'available' and "deletedAt" is null
    and (regexp_match(sku, '-(\d+)$'))[1]::int > 4000
    and "speciesId" is not null
)
on conflict ("varietyId", epithet) do nothing;

-- ── 3. Move the target items' photos to BAE (BEFORE the flip, while the items
--       still match the Folia predicate; itemId is unchanged by the flip) ────
update item_photos
set "brandId" = 'bae'
where "itemId" in (
  select id from inventory_items
  where "brandId" = 'folia' and lower(coalesce(variety, '')) = 'anthurium'
    and status = 'available' and "deletedAt" is null
    and (regexp_match(sku, '-(\d+)$'))[1]::int > 4000
);

-- ── 4. Re-home the items (LAST). 4a: re-point species (matched by epithet, so
--       it's correct regardless of id) + flip brand. 4b: null-species items. ─
update inventory_items i
set "brandId" = 'bae', "speciesId" = bs.id
from species fs
join species bs
  on bs."varietyId" = 'var_anthurium_bae' and bs.epithet = fs.epithet and bs."brandId" = 'bae'
where i."brandId" = 'folia' and lower(coalesce(i.variety, '')) = 'anthurium'
  and i.status = 'available' and i."deletedAt" is null
  and (regexp_match(i.sku, '-(\d+)$'))[1]::int > 4000
  and i."speciesId" = fs.id;

update inventory_items
set "brandId" = 'bae'
where "brandId" = 'folia' and lower(coalesce(variety, '')) = 'anthurium'
  and status = 'available' and "deletedAt" is null
  and (regexp_match(sku, '-(\d+)$'))[1]::int > 4000
  and "speciesId" is null;

-- ── 5. Verification (review before COMMIT) ──────────────────────────────────
-- Expected: remaining=0, bae_anthurium_items=554, bae_species=21,
--           orphan_species_refs=0, folia_anthurium_remaining=266 (820 - 554).
select 'folia anthurium >4000 available remaining (want 0)' as label, count(*) as n
  from inventory_items
  where "brandId"='folia' and lower(coalesce(variety,''))='anthurium'
    and status='available' and "deletedAt" is null and (regexp_match(sku,'-(\d+)$'))[1]::int > 4000
union all
select 'bae anthurium items (want 554)', count(*)
  from inventory_items where "brandId"='bae' and lower(coalesce(variety,''))='anthurium'
union all
select 'bae anthurium species (want 21)', count(*)
  from species where "brandId"='bae' and "varietyId"='var_anthurium_bae'
union all
select 'bae items pointing at non-bae species (want 0)', count(*)
  from inventory_items i left join species s on s.id = i."speciesId"
  where i."brandId"='bae' and i."speciesId" is not null and (s.id is null or s."brandId" <> 'bae')
union all
select 'folia anthurium remaining total (kept: <=4000 + shipped/sold)', count(*)
  from inventory_items where "brandId"='folia' and lower(coalesce(variety,''))='anthurium' and "deletedAt" is null;

commit;
