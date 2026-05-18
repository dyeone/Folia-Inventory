-- 0013 · Add 'packer' role to users.
--
-- Packers are limited-scope warehouse staff. They see only the Shipping
-- tab and operate the per-item pack workflow (scan box → scan items →
-- items flip from unpacked to packed). They have no read/write on
-- inventory, sales, finances, etc.
--
-- Idempotent — drops the old constraint if it exists, recreates with
-- 'packer' added.

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('admin','staff','packer'));

insert into applied_migrations (id) values ('0013_packer_role')
  on conflict (id) do nothing;
