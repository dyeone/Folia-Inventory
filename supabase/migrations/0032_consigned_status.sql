-- 0032 · Add 'consigned' to inventory_items.status.
--
-- "On consignment" = a plant physically handed to another seller who sells it
-- on our behalf; when it sells, the profit is split. It's not our own available
-- stock anymore, but it's also not a realized sale — so it's a distinct
-- lifecycle state, not a flavor of sold/available. Revenue is only booked once
-- the operator later flips it to 'sold' with the shared amount, so no financial
-- code needs to treat 'consigned' as income.
--
-- Schema-only: mirrors 0009. The status is set from the web app (per-row
-- dropdown, item form, and BAE's Status Change scan mode). Idempotent — the
-- check is dropped and re-added with `if exists` guards.

alter table inventory_items drop constraint if exists inventory_items_status_check;
alter table inventory_items add constraint inventory_items_status_check
  check (status in ('available','listed','sold','shipped','delivered','converted','refunded','acclimated','consigned'));

insert into applied_migrations (id) values ('0032_consigned_status')
  on conflict (id) do nothing;
