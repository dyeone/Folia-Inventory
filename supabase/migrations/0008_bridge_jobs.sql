-- 0008 · Bridge jobs queue.
--
-- Backs the durable work queue between the Folia web app and the local
-- Folia Bridge that drives an Android phone via ADB. The bridge can't
-- accept inbound HTTPS from Vercel (mixed-content + NAT), so the flow
-- is inverted: Folia enqueues jobs here, the bridge polls outbound for
-- the next pending one. `claimedBy` + the partial index lets multiple
-- bridge instances coexist later without double-running jobs.
--
-- Also adds `bridgeToken` to users — long-lived bearer token the bridge
-- uses on every poll. Issued on demand via /api/bridge?action=generate-token.
--
-- Idempotent.

create table if not exists bridge_jobs (
  id            text        primary key,
  status        text        not null default 'queued'
                              check (status in ('queued','running','done','failed')),
  action        text        not null,
  payload       jsonb       not null default '{}'::jsonb,
  result        jsonb,
  error         text,
  "createdAt"   timestamptz not null default now(),
  "createdBy"   text,
  "claimedAt"   timestamptz,
  "claimedBy"   text,
  "completedAt" timestamptz
);

-- Partial index: the polling query only ever asks for queued + running
-- rows. Keeping a slim index instead of a full one stays cheap as the
-- table grows with completed jobs.
create index if not exists bridge_jobs_pending_idx
  on bridge_jobs (status, "createdAt")
  where status in ('queued','running');

alter table users add column if not exists "bridgeToken" text;
create unique index if not exists users_bridge_token_idx
  on users ("bridgeToken")
  where "bridgeToken" is not null;

alter table bridge_jobs enable row level security;

insert into applied_migrations (id) values ('0008_bridge_jobs')
  on conflict (id) do nothing;
