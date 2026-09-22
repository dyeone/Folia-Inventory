-- 0044 · Species sell note.
--
-- What the streamer says about a species on a live — selling points, care
-- hints, "this batch has 4-5 leaves". Edited from the wholesale order line and
-- the catalog (any active user; it's operational, not structural), and shown
-- on the live scan screen next to the species list price (idealSellingPrice,
-- now labelled "List price" in the UI). Not stamped onto items: the live
-- surfaces look it up by speciesId so an edit shows on the next scan.

alter table species add column if not exists "sellNote" text;

insert into applied_migrations (id) values ('0044_species_sell_note')
  on conflict (id) do nothing;
