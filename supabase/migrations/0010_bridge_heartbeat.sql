-- 0010 · Bridge heartbeat.
--
-- The old liveness signal inferred "online" from recent job activity in
-- bridge_jobs (a claim or completion in the last 30 s). That gave a false
-- "offline" reading whenever the bridge was up but idle, because the
-- bridge's /next polls return null jobs without leaving any trace.
--
-- This migration adds an explicit heartbeat column on the user that owns
-- the bridge token. The /next handler now writes "bridgeLastSeen" on
-- every poll (~every 1.5 s), and /health reads it directly.
--
-- Idempotent.

alter table users add column if not exists "bridgeLastSeen" timestamptz;

insert into applied_migrations (id) values ('0010_bridge_heartbeat')
  on conflict (id) do nothing;
