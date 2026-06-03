-- 0025 · Per-box carrier override.
--
-- The effective carrier for a box is derived from its contents: any anthurium
-- item makes it a UPS box, otherwise it falls back to the carrier stamped on
-- its items at order-apply time (which still encodes the legacy "UPS 2-Day
-- Upgrade" line rule), else USPS. This column lets an operator override that
-- derived default by hand for a single box; null = follow the rule.
--
-- Derived live at read time, so existing boxes follow the rule with no
-- backfill. Nullable, lazy-created with the rest of the shipment_boxes row.
-- Idempotent.

alter table shipment_boxes add column if not exists "carrierOverride" text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shipment_boxes_carrieroverride_check') then
    alter table shipment_boxes add constraint shipment_boxes_carrieroverride_check
      check ("carrierOverride" is null or "carrierOverride" in ('usps','ups'));
  end if;
end $$;

insert into applied_migrations (id) values ('0025_box_carrier_override')
  on conflict (id) do nothing;
