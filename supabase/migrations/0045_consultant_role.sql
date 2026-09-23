-- 0045 · Add 'consultant' role to users.
--
-- A consultant prices the wholesale orders: they log in to a mobile-only
-- screen (src/consult/ConsultantView.jsx) that lists purchase orders and,
-- per line, lets them set the species LIST price and the seller note — the
-- same species fields the streamer sees on scan. No inventory, sales,
-- packing, or cost access: the purchase-orders API already strips costs for
-- non-admins and the species API strips wholesalePrice for this role.
--
-- Idempotent — drops the old constraint if it exists, recreates with
-- 'consultant' added.

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('admin','staff','packer','consultant'));

insert into applied_migrations (id) values ('0045_consultant_role')
  on conflict (id) do nothing;
