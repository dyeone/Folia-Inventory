-- 0011 · Allow lotKind='unmatched' on inventory_items.
--
-- Placeholder rows created at Validate-Sales apply time for Palmstreet
-- order lines whose SKU didn't match any real inventory item. The
-- placeholder still goes into the Shipping tab (so nothing gets dropped)
-- but renders purple to flag that it's not linked to real inventory.
--
-- Idempotent — drops the old constraint if it exists, recreates with
-- the expanded value set.

alter table inventory_items drop constraint if exists inventory_items_lotkind_check;
alter table inventory_items add constraint inventory_items_lotkind_check
  check ("lotKind" in ('sale','giveaway','unmatched'));

insert into applied_migrations (id) values ('0011_unmatched_lotkind')
  on conflict (id) do nothing;
