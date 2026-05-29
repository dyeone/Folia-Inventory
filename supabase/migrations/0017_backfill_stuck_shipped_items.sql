
-- 0017 · One-time data fix — for every box that has at least one
-- shipped/delivered item, flip every remaining non-shipped item in
-- that box to status='shipped'. Repairs boxes that ended up partially
-- shipped (the prior Mark Shipped handler only flipped status='sold'
-- items, so any item in a different non-terminal state got left behind
-- and the box silently disappeared from both the Ready and Shipped
-- list views).
--
-- ⚠ Destructive: this also overwrites any 'refunded' status to
-- 'shipped' inside such boxes. For a full refund on an item that
-- never physically shipped, this is technically wrong (the item
-- didn't ship). Operationally though, the user explicitly asked for
-- every item inside an already-shipped box to be marked shipped, and
-- the box's `shipments` row + tracking number tells the more accurate
-- story than the per-item status anyway. The `refundedAmount` column
-- is untouched so the financial trail survives.
--
-- shippedAt is set to now() only for items that don't already have one
-- (preserves the actual ship timestamp on items that previously shipped
-- correctly).
--
-- Idempotent: re-running this is a no-op because every targeted item
-- becomes 'shipped' on the first run, excluding it from the next.

update inventory_items
set status = 'shipped',
    "shippedAt" = coalesce("shippedAt", now())
where "deletedAt" is null
  and status not in ('shipped', 'delivered')
  and "shipmentBoxId" in (
    select "shipmentBoxId"
    from inventory_items
    where "shipmentBoxId" is not null
      and "deletedAt" is null
      and status in ('shipped', 'delivered')
  );

insert into applied_migrations (id) values ('0017_backfill_stuck_shipped_items')
  on conflict (id) do nothing;
