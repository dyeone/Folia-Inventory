-- 0027 · Persist the read-only "Evaluate Sales" report per sale event.
--
-- The per-live sales evaluation (parsed Palmstreet order lines joined to
-- inventory cost, plus the rolled-up financials + seller commission) was cached
-- only in the browser's localStorage, so it was per-device and lost on a cache
-- clear. This table makes it durable and cross-device. One row per sale event;
-- re-evaluating upserts. It is a READ-ONLY snapshot — it never marks inventory
-- sold (that is Validate Sales). The whole result object is stored as jsonb so
-- its shape can evolve with the client (result.version gates compatibility).
--
-- Idempotent. ON DELETE CASCADE so deleting a sale event drops its evaluation.

create table if not exists sale_evaluations (
  "saleId"    text        primary key references sales(id) on delete cascade,
  result      jsonb       not null,
  "updatedAt" timestamptz not null default now(),
  "updatedBy" text
);

insert into applied_migrations (id) values ('0027_sale_evaluations')
  on conflict (id) do nothing;
