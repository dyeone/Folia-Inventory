-- 0003 · Auth attempt log for login rate limiting.
-- The /api/auth login handler counts failed attempts per username inside
-- a 15-minute window and locks the account when the count crosses 10.
-- Idempotent.

create table if not exists auth_attempts (
  id            bigserial   primary key,
  username      text        not null,
  succeeded     boolean     not null,
  ip            text,
  "attemptedAt" timestamptz not null default now()
);
create index if not exists auth_attempts_username_time_idx
  on auth_attempts (username, "attemptedAt" desc);

insert into applied_migrations (id) values ('0003_auth_attempts')
  on conflict (id) do nothing;
