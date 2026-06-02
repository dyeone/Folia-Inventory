-- 0024 · Per-item shipping fee paid by the buyer.
--
-- Palmstreet's orders export carries a "Shipping Fee" per order line. We
-- already parse it (parsePalmstreetOrders summed it into box.shippingFee)
-- but never persisted it. This stores it on the inventory item at
-- Validate-Sales time so the Shipping tab can total what a buyer paid to
-- ship a box and compare it against the label cost — surfacing boxes we
-- lose money on.
--
-- Per-item (not per-box) on purpose: items are upserted in place, so
-- re-uploading the same file is idempotent, and a buyer's later order
-- merging into an open box brings its own fee. A bundled row that names
-- multiple SKUs splits its fee evenly across the emitted items (the same
-- way price is split), so summing a box's items reproduces the order
-- total. Nullable — historical rows simply read as 0 when summed.

alter table inventory_items add column if not exists "orderShippingFee" numeric;

insert into applied_migrations (id) values ('0024_item_order_shipping_fee')
  on conflict (id) do nothing;
