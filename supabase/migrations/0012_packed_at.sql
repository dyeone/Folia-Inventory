-- 0012 · Per-item packed status for the Shipping tab.
--
-- Each item in an open box can be 'unpacked' (packedAt = null) or
-- 'packed' (packedAt = timestamp the operator marked it). The flag is
-- independent of the main status column — items stay 'sold' through the
-- pack-out, then flip to 'shipped' on Mark shipped. This lets the
-- operator track partial packing progress within a box without losing
-- the sold/shipped distinction.
--
-- Idempotent.

alter table inventory_items add column if not exists "packedAt" timestamptz;

insert into applied_migrations (id) values ('0012_packed_at')
  on conflict (id) do nothing;
