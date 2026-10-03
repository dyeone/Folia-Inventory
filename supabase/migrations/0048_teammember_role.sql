-- Roles: 'packer' becomes 'teammember' (same screen, same permissions —
-- the packing bench, no prices), and 'staff' is removed. The app has read
-- both old names as 'teammember' since the code deploy, so this migration
-- can run at any time after it; until it runs, creating a user with the
-- old names is already refused.
--
-- Apply by hand in the Supabase SQL editor.

alter table users drop constraint if exists users_role_check;

update users set role = 'teammember' where role in ('packer', 'staff');

alter table users alter column role set default 'teammember';

alter table users add constraint users_role_check
  check (role in ('admin', 'teammember', 'consultant'));

insert into applied_migrations (id) values ('0048_teammember_role')
  on conflict (id) do nothing;
