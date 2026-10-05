-- One person can hold several roles (a streamer who also packs). `roles`
-- is the set; `role` stays the primary one (admin if held, else the first)
-- for the check constraint, the last-admin guard and older readers. The
-- app reads [role] as the set until this runs; assigning more than one
-- role is refused with a message naming this migration until then.
--
-- Apply by hand in the Supabase SQL editor.

alter table users add column if not exists roles text[];

update users set roles = array[role] where roles is null or cardinality(roles) = 0;

insert into applied_migrations (id) values ('0050_user_roles_set')
  on conflict (id) do nothing;
