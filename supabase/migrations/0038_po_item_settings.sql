-- 0038: per-PO item settings.
--
-- A purchase order now carries how its items should be minted at receive
-- time: item type (plant vs tissue culture — TC shipments were previously
-- forced to 'plant'), the initial status, and an optional note stamped on
-- every item. Chosen by the admin when creating/importing the order
-- (ImportOrderModal / PurchaseOrderCard); receive-line reads them when
-- minting inventory_items. Defaults preserve today's behavior exactly.

alter table purchase_orders
  add column if not exists "itemType"   text not null default 'plant'
    check ("itemType" in ('plant','tc')),
  add column if not exists "itemStatus" text not null default 'available'
    check ("itemStatus" in ('available','acclimated')),
  add column if not exists "itemNotes"  text;

insert into applied_migrations (id) values ('0038_po_item_settings')
on conflict (id) do nothing;
