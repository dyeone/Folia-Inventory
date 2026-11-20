-- 0054 · The CEO role (2026-11-19).
--
-- 'ceo' sees only the Inventory and For Sale tabs: what an admin sees there
-- (costs included) and the For Sale workflow (the pool, the website push,
-- sale events), with no admin powers elsewhere. `role` holds the primary
-- role, so its check constraint has to know the new name; `roles` (0050)
-- has no constraint. Until this runs, giving someone the CEO role is
-- refused with a message naming this migration.
--
-- Idempotent. Apply by hand in the Supabase SQL editor.

alter table users drop constraint if exists users_role_check;

alter table users add constraint users_role_check
  check (role in ('admin', 'ceo', 'packer', 'streamer', 'consultant'));

insert into applied_migrations (id) values ('0054_ceo_role')
  on conflict (id) do nothing;
