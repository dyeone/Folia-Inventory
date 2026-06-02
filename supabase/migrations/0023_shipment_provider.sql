-- 0023 · Label provider on shipments.
--
-- Labels can now be purchased through EITHER ShipStation or Shippo
-- (operator picks per box). The shipments row needs to record which
-- platform sold the label so voids route correctly:
--   ShipStation → POST /shipments/voidlabel (uses shipstationShipmentId)
--   Shippo      → POST /refunds            (uses shippoTransactionId)
--
-- `provider` is nullable: pre-existing rows are ShipStation labels (or
-- the manual Palmstreet-USPS flow, distinguished by carrierCode); code
-- treats a null provider as 'shipstation' unless carrierCode='palmstreet'.
-- Idempotent.

alter table shipments add column if not exists provider text;
alter table shipments add column if not exists "shippoTransactionId" text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shipments_provider_check') then
    alter table shipments add constraint shipments_provider_check
      check (provider is null or provider in ('shipstation','shippo','palmstreet'));
  end if;
end $$;

insert into applied_migrations (id) values ('0023_shipment_provider')
  on conflict (id) do nothing;
