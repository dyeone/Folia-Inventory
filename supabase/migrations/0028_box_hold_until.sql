-- 0028 · Per-box one-week hold.
--
-- Some boxes need to sit before shipping (e.g. plants acclimating). An
-- operator puts a box "on hold" and the Shipping tab marks it a special
-- colour with a countdown; once holdUntil passes, the box flips to a
-- "Time to ship" call-to-action. The whole thing is derived live from this
-- one timestamp compared against the current time — no cron, no status flips.
--
-- null = not on hold. Lazy-created with the rest of the shipment_boxes row.
-- Idempotent.

alter table shipment_boxes add column if not exists "holdUntil" timestamptz;

insert into applied_migrations (id) values ('0028_box_hold_until')
  on conflict (id) do nothing;
