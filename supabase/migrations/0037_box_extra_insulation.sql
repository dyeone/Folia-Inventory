-- 0037: manual per-box "extra insulation" mark.
--
-- Set from the Shipping tab (desk decides a box needs extra insulation —
-- cold snap, tender plant, buyer request) and surfaced prominently in the
-- packer UI. Distinct from the heat-check flags, which are COMPUTED from
-- destination forecasts; this one is the operator's manual call and rides
-- the same shipment_boxes row + box-notes poll the other box marks use.
--
-- Nullable boolean on the lazy shipment_boxes row — same add-column pattern
-- as 0022 (packaging) and 0025 (carrier override). false is stored as null
-- so "un-marked" and "never marked" read identically.

alter table shipment_boxes add column if not exists "extraInsulation" boolean;

insert into applied_migrations (id) values ('0037_box_extra_insulation')
  on conflict (id) do nothing;
