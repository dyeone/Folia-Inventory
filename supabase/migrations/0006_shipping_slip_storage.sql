-- 0006 · Shipping slip is a second PDF (the packing slip that goes inside
-- the box) on top of the address label. Both come from Palmstreet during
-- the same buy-label flow. Stored alongside the existing labelStoragePath
-- so the Print buttons can fetch each independently.
--
-- Idempotent.

alter table shipments add column if not exists "shippingSlipStoragePath" text;

insert into applied_migrations (id) values ('0006_shipping_slip_storage')
  on conflict (id) do nothing;
