-- 0018 · Per-box metadata table.
--
-- A "box" was previously a virtual entity in the codebase: a set of
-- inventory_items sharing a shipmentBoxId. The shipments table holds
-- bought-label rows keyed by that id but its NOT NULL columns are
-- shaped around "a label was purchased" — no good place to hang
-- per-box metadata that exists before (or independent of) a label.
--
-- Elevate the box to its own row. Today it holds the operator's
-- internal seller-note; the table is set up to grow into a home for
-- box-level weight / dims / priority / instructions without
-- contorting shipments.
--
-- Rows are lazy-created the first time the operator saves a note on
-- a box. Missing row = no note. No backfill needed.

create table if not exists shipment_boxes (
  id          text        primary key,            -- = shipmentBoxId on inventory_items
  note        text,                               -- operator's internal note; nullable when cleared
  "updatedAt" timestamptz not null default now(),
  "updatedBy" text
);

alter table shipment_boxes enable row level security;
