-- 0040 · Allow 'ups_next_day_air' in shipment_boxes.serviceKey.
--
-- The full UPS Next Day Air service (morning delivery — Saver is
-- end-of-day) was added to SHIPPING_SERVICES and the packing UI, but the
-- serviceKey check constraint from 0022 still only listed the original
-- three services, so picking it failed with
-- "violates check constraint shipment_boxes_servicekey_check".
--
-- Drop + recreate the constraint with the fourth key. Idempotent:
-- re-running just recreates the same constraint.

alter table shipment_boxes drop constraint if exists shipment_boxes_servicekey_check;
alter table shipment_boxes add constraint shipment_boxes_servicekey_check
  check ("serviceKey" is null or "serviceKey" in
    ('usps_priority','ups_2nd_day_air','ups_next_day_air_saver','ups_next_day_air'));

insert into applied_migrations (id) values ('0040_servicekey_next_day_air')
  on conflict (id) do nothing;
