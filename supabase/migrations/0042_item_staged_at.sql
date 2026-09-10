-- 0042 · Persist lineup staging order.
--
-- The Pre Sale tab's staged list kept its scan order only in component
-- state (addedOrder): navigating away and back — or another device —
-- collapsed every un-numbered staged row into SKU order, silently
-- reordering a lineup the operator had scanned in deliberate bench order.
--
-- stagedAt is stamped when a plant is staged onto a sale (and nulled when
-- un-staged); un-numbered staged rows sort by it, so the receipt order
-- survives remounts, reloads, and devices. Numbered rows still sort by
-- lotNumber — numbering remains the durable order of record. Idempotent.

alter table inventory_items add column if not exists "stagedAt" timestamptz;

insert into applied_migrations (id) values ('0042_item_staged_at')
  on conflict (id) do nothing;
