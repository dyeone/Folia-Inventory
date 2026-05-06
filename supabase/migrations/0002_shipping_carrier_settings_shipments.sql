-- 0002 · Carrier classification + shipping infra (ShipStation foundation).
-- Adds shipmentCarrier on inventory_items so the Packing tab can split
-- boxes by carrier; adds the app_settings table for ship-from + carrier
-- defaults; adds the shipments table that holds purchased labels.
-- Idempotent.

alter table inventory_items add column if not exists "shipmentCarrier" text default 'usps';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_shipcarrier_check') then
    alter table inventory_items add constraint inventory_items_shipcarrier_check
      check ("shipmentCarrier" in ('usps','ups'));
  end if;
end $$;
create index if not exists inventory_items_shipcarrier_idx on inventory_items ("shipmentCarrier");

create table if not exists app_settings (
  id          text        primary key,
  data        jsonb       not null default '{}'::jsonb,
  "updatedAt" timestamptz not null default now(),
  "updatedBy" text
);

create table if not exists shipments (
  id                       text        primary key,
  "saleId"                 text,
  carrier                  text        not null check (carrier in ('usps','ups')),
  "carrierCode"            text        not null,
  "serviceCode"            text        not null,
  "packageCode"            text        not null default 'package',
  "weightOz"               numeric     not null,
  "dimsLength"             numeric,
  "dimsWidth"              numeric,
  "dimsHeight"             numeric,
  "shipFrom"               jsonb       not null,
  "shipTo"                 jsonb       not null,
  "trackingNumber"         text,
  "labelCost"              numeric,
  "labelData"              text,
  "shipstationShipmentId"  text,
  "shipstationLabelId"     text,
  "isTestLabel"            boolean     not null default false,
  "purchasedAt"            timestamptz not null default now(),
  "purchasedBy"            text,
  "voidedAt"               timestamptz,
  "voidedBy"               text
);
create index if not exists shipments_saleid_idx on shipments ("saleId");
create index if not exists shipments_carrier_idx on shipments (carrier);

alter table app_settings enable row level security;
alter table shipments    enable row level security;

insert into applied_migrations (id) values ('0002_shipping_carrier_settings_shipments')
  on conflict (id) do nothing;
