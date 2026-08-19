-- Per-LINE item type override (nullable — null inherits the PO's itemType).
-- Mixed wholesale orders arrive with some lines as TC plantlets and some as
-- potted plants; the per-PO setting (0038) can't express that. Only lines
-- with nothing received should be changed (enforced in the API, not here).
alter table purchase_order_lines
  add column if not exists "itemType" text
  check ("itemType" is null or "itemType" in ('plant', 'tc'));
