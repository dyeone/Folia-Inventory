-- Roles: the single 'teammember' role (0048) splits into 'packer' (the
-- packing bench: shipping + TC acclimation, no prices) and the new
-- 'streamer' (availability, the schedule, the available inventory with list
-- prices and sell notes). Existing team members become packers — the admin
-- reassigns the streamers in Users. The app has read 'teammember' as
-- 'packer' since the code deploy, so this can run at any time after it.
--
-- Apply by hand in the Supabase SQL editor.

alter table users drop constraint if exists users_role_check;

update users set role = 'packer' where role in ('teammember', 'staff');

alter table users alter column role set default 'packer';

alter table users add constraint users_role_check
  check (role in ('admin', 'packer', 'streamer', 'consultant'));

insert into applied_migrations (id) values ('0049_packer_streamer_roles')
  on conflict (id) do nothing;
