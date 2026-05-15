-- 0009 · Add 'acclimated' to inventory_items.status.
--
-- Acclimated TCs are ones that arrived in poor condition and got potted
-- to recover; they're not for direct sale, and when eventually sold (as
-- a grown plant) they should command a higher profit rate to cover the
-- extra labor and time. The bump itself is applied at status-change
-- time in the web app — this migration only opens the schema for it.
--
-- Idempotent: drops and re-adds the check, both with `if exists` guards.

alter table inventory_items drop constraint if exists inventory_items_status_check;
alter table inventory_items add constraint inventory_items_status_check
  check (status in ('available','listed','sold','shipped','delivered','converted','refunded','acclimated'));

insert into applied_migrations (id) values ('0009_acclimated_status')
  on conflict (id) do nothing;
