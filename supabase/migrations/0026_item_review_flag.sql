-- 0026 · Per-item review flag.
--
-- Validate Sales can now detect a likely DOUBLE-SALE: an order line whose SKU
-- matches an item that is ALREADY shipped, but whose order #/buyer/address/
-- sold-date do NOT match that shipped box (so the same physical plant looks
-- like it sold twice). When that happens we flag the existing shipped item and
-- create a flagged second-sale line so the operator can decide how to handle
-- it. `reviewFlag` carries that mark; null = nothing to review.
--
-- Nullable, idempotent. Constrained to known flag values so a typo can't slip
-- in; extend the IN-list when new review reasons are added.

alter table inventory_items add column if not exists "reviewFlag" text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_reviewflag_check') then
    alter table inventory_items add constraint inventory_items_reviewflag_check
      check ("reviewFlag" is null or "reviewFlag" in ('double_sale'));
  end if;
end $$;

insert into applied_migrations (id) values ('0026_item_review_flag')
  on conflict (id) do nothing;
