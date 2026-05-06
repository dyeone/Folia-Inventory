-- 0004 · Move ShipStation label PDFs out of the shipments row.
-- Inline base64 labelData was 50–100KB per row — fine at low volume,
-- but it bloats the table over a year of sales and makes shipments
-- scans slow. New labels upload to Supabase Storage; the row only
-- holds the path and a fresh signed URL is minted on demand.
--
-- BUCKET REQUIRED: a private storage bucket named `shipping-labels`
-- must exist before the new buy-label flow works. Create it in the
-- Supabase Dashboard → Storage → New bucket. Keep it private; the
-- service-role key (used by /api routes) bypasses RLS to upload, and
-- the client only ever sees short-lived signed URLs.
--
-- Idempotent.

alter table shipments add column if not exists "labelStoragePath" text;

insert into applied_migrations (id) values ('0004_label_storage_path')
  on conflict (id) do nothing;
