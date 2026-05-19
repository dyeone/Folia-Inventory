-- Persisted phone connection target reported by the Android Bridge
-- Helper. Whenever wireless debugging is on, the helper does mDNS
-- discovery of its own _adb-tls-connect._tcp.local service and POSTs
-- the resolved {ip, port} here via /api/bridge?action=phone-heartbeat.
-- bridge/reconnect.sh then pulls phoneIp + phonePort instead of doing
-- its own `adb mdns services` lookup.
--
-- One row per user (the row that owns the bridge token). No FK to a
-- separate table — keeps the schema small and the heartbeat write a
-- single update.

alter table users
  add column if not exists "phoneIp"        text,
  add column if not exists "phonePort"      integer,
  add column if not exists "phoneLastSeen"  timestamptz;
