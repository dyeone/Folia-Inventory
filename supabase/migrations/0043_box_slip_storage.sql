-- 0043 · Per-box stored shipping slip (Nigel / BoyGardening order slips).
--
-- Nigel's orders arrive as a PDF of order slips (one order per page) that
-- the desk uploads on the Shipping tab. Each order becomes an open box of
-- placeholder items, and the slip page(s) for that box are kept in the
-- private `shipping-labels` Storage bucket so the packer can print the
-- slip at pack time. Before this, a slip PDF only existed on the
-- `shipments` row written by the Palmstreet label flow — these boxes have
-- no shipments row until a label is bought, so the path lives on the lazy
-- per-box `shipment_boxes` row instead, next to the other desk marks
-- (note / size / hold / insulation) that the packer already polls.
--
-- Nullable text; same add-column pattern as 0022/0025/0037. Idempotent.
-- GET label-url?kind=slip falls back to this column when the shipments
-- row has no slip, and box-notes surfaces it as `slipStoragePath`.

alter table shipment_boxes add column if not exists "slipStoragePath" text;

insert into applied_migrations (id) values ('0043_box_slip_storage')
  on conflict (id) do nothing;
