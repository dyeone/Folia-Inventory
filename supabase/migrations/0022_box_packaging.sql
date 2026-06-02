-- 0022 · Per-box packaging selection (box size + weight + service).
--
-- 0018 created shipment_boxes to hold per-box metadata and explicitly
-- reserved room "to grow into a home for box-level weight / dims /
-- priority". This is that growth: the operator picks, per box, which
-- packaging preset (defined in app_settings.id='shipping' → boxSizes)
-- it ships in, the actual weight, and which of the three offered
-- services (USPS Priority / UPS 2nd Day Air / UPS Next Day Air Saver)
-- it goes by. These feed the Shippo-vs-ShipStation rate comparison.
--
-- Dims themselves are NOT snapshotted here — they're resolved from the
-- referenced boxSizes preset at use time so editing a preset updates
-- every box on it. boxSizeId is just the preset id (or null).
--
-- All nullable; rows stay lazy-created (first note OR first packaging
-- save). Idempotent.

alter table shipment_boxes add column if not exists "boxSizeId" text;
alter table shipment_boxes add column if not exists "weightOz"  numeric;
alter table shipment_boxes add column if not exists "serviceKey" text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shipment_boxes_servicekey_check') then
    alter table shipment_boxes add constraint shipment_boxes_servicekey_check
      check ("serviceKey" is null or "serviceKey" in
        ('usps_priority','ups_2nd_day_air','ups_next_day_air_saver'));
  end if;
end $$;

insert into applied_migrations (id) values ('0022_box_packaging')
  on conflict (id) do nothing;
