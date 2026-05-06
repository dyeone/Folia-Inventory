# Supabase migrations

`schema.sql` in the parent folder is the **fresh-install script** — running
it on an empty database produces the current schema. It's idempotent (every
statement uses `if not exists` / `if not exists check`), so re-running it on
an existing database is also safe and a no-op.

This folder holds **incremental migrations** — one file per schema change,
numbered so the order is unambiguous. New migrations go here as soon as
the change ships in code, and `schema.sql` is updated to match.

## Naming

`NNNN_short_description.sql` where `NNNN` is a zero-padded sequence number.
Each file is also idempotent (uses `if not exists`/`if exists` guards) so
running it twice does nothing on the second pass.

## Applying

Until we have an automated runner, paste the file into the Supabase SQL
editor (Dashboard → SQL Editor → New Query) and run. Each new migration
file should be applied once per environment (Production + any Preview DBs).

To check what's applied, look at `applied_migrations` (introduced in
`0001`) — every migration script ends with an insert there so we have a
log of what's been run when.
