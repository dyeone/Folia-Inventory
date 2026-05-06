-- 0001 · Bootstrap migration tracking. Idempotent.
-- Every subsequent migration file ends with an insert into this table so we
-- can see which migrations have been applied to a given database.

create table if not exists applied_migrations (
  id          text        primary key,
  applied_at  timestamptz not null default now()
);

insert into applied_migrations (id) values ('0001_init_migration_tracking')
  on conflict (id) do nothing;
