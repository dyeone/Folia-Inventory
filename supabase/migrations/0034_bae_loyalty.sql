-- 0034 · BAE loyalty: collectible badges (数字徽章) + punch-card rewards.
--
-- Customer-facing loyalty loop for the BAE mobile app (separate Expo repo,
-- ~/Projects/bae-loyalty-app — see its DESIGN.md): every packed BAE box gets
-- a redemption code (QR + short code) printed on the shipping slip; the buyer
-- scans it in-app to claim one badge per plant in the box; every `threshold`
-- badges auto-creates a reward redemption the customer shows staff.
--
-- AUDIENCE SPLIT (deliberate): customers authenticate with Supabase Auth
-- (email OTP), NOT the staff users table. Customer-facing tables therefore
-- carry real RLS policies for the `authenticated` role — unlike staff tables,
-- which enable RLS with no policies — because the app talks to Supabase
-- directly (bypassing the capped Vercel /api). The one racy operation
-- (validate → claim → grant → maybe unlock) is the SECURITY DEFINER
-- claim_redemption_code() RPC at the bottom; codes themselves are never
-- readable by clients, so they can't be enumerated.
--
-- Depends on 0029 (brands). Idempotent.

-- ── customers ──────────────────────────────────────────────────────────────
-- One row per app account, id = Supabase Auth uid. The app upserts this row
-- after first sign-in (no auth.users trigger — easier to debug, and the RLS
-- check makes it safe). brandId records which brand's app they signed up in;
-- badges/rewards carry their own brandId per row.

create table if not exists customers (
  id            uuid        primary key references auth.users(id) on delete cascade,
  "brandId"     text        not null default 'bae' references brands(id),
  "displayName" text,
  email         text,
  phone         text,
  "createdAt"   timestamptz not null default now()
);

alter table customers enable row level security;

drop policy if exists customers_select_own on customers;
create policy customers_select_own on customers
  for select to authenticated using (id = auth.uid());
drop policy if exists customers_insert_own on customers;
create policy customers_insert_own on customers
  for insert to authenticated with check (id = auth.uid());
drop policy if exists customers_update_own on customers;
create policy customers_update_own on customers
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ── redemption_codes ───────────────────────────────────────────────────────
-- One code per packed box (v1 punch-card granularity; per-plant codes are the
-- v2 gallery option). Generated server-side at slip-print time (service role,
-- api/shipments.js) so the code always exists before it's printed. `code` is
-- canonical uppercase alphanumeric with an unambiguous alphabet (no 0/O/1/I/L)
-- — the slip prints it dash-grouped, the RPC strips non-alphanumerics before
-- matching. badgeCount = plants in the box at print time; refreshed while
-- unclaimed if box contents change.
--
-- RLS enabled with NO policies on purpose: clients must never select codes
-- (enumeration risk). The claim path is the RPC; generation is service-role.

create table if not exists redemption_codes (
  id              text        primary key,                    -- 'rc_' + random
  code            text        not null,                       -- canonical: upper alnum, no separators
  "qrPayload"     text        not null,                       -- exact string the slip QR encodes
  "shipmentBoxId" text        not null,
  "brandId"       text        not null references brands(id),
  "badgeCount"    integer     not null check ("badgeCount" > 0),
  status          text        not null default 'unclaimed' check (status in ('unclaimed','claimed')),
  "claimedBy"     uuid        references customers(id) on delete set null,
  "claimedAt"     timestamptz,
  "createdAt"     timestamptz not null default now(),
  "createdBy"     text
);

create unique index if not exists redemption_codes_code_unique
  on redemption_codes (upper(code));
-- one code per box keeps get-or-create at print time idempotent
create unique index if not exists redemption_codes_box_unique
  on redemption_codes ("shipmentBoxId");
create index if not exists redemption_codes_claimedby_idx
  on redemption_codes ("claimedBy") where "claimedBy" is not null;

alter table redemption_codes enable row level security;

-- ── badge_events ───────────────────────────────────────────────────────────
-- One row per badge earned. Progress = count(*) for the customer+brand.
-- plantRef stays nullable until the v2 species gallery needs it.

create table if not exists badge_events (
  id             text        primary key,                     -- 'be_' + random
  "customerId"   uuid        not null references customers(id) on delete cascade,
  "sourceCodeId" text        not null references redemption_codes(id),
  "plantRef"     text,                                        -- species/sku, v2 gallery
  "brandId"      text        not null references brands(id),
  "createdAt"    timestamptz not null default now()
);

create index if not exists badge_events_customer_idx
  on badge_events ("customerId", "brandId");

alter table badge_events enable row level security;

drop policy if exists badge_events_select_own on badge_events;
create policy badge_events_select_own on badge_events
  for select to authenticated using ("customerId" = auth.uid());
-- no insert/update policies: badges are only granted by the RPC / service role

-- ── reward_config ──────────────────────────────────────────────────────────
-- The punch-card economics, editable by staff (admin UI writes via the
-- existing Vercel /api with the service key). Readable by any signed-in
-- customer — threshold + reward text are public marketing copy.

create table if not exists reward_config (
  "brandId"      text        primary key references brands(id),
  threshold      integer     not null check (threshold > 0),
  "rewardTitle"  text        not null,
  "rewardDetail" text,
  active         boolean     not null default true,
  "updatedAt"    timestamptz not null default now(),
  "updatedBy"    text
);

alter table reward_config enable row level security;

drop policy if exists reward_config_select_all on reward_config;
create policy reward_config_select_all on reward_config
  for select to authenticated using (true);

-- Seed BAE with the placeholder economics from DESIGN.md ("collect 10 →
-- reward"); staff set the real reward text in the admin UI before launch.
insert into reward_config ("brandId", threshold, "rewardTitle", "rewardDetail")
  values ('bae', 10, 'Free BAE anthurium', 'Collect 10 badges and get a free collectible anthurium on your next order. Show this reward code to staff to redeem.')
  on conflict ("brandId") do nothing;

-- ── reward_redemptions ─────────────────────────────────────────────────────
-- Created by the RPC each time a customer's badge total crosses a multiple of
-- the threshold. `code` is what the customer shows staff (staff verify + mark
-- fulfilled in the admin UI, which uses the service key).

create table if not exists reward_redemptions (
  id             text        primary key,                     -- 'rr_' + random
  "customerId"   uuid        not null references customers(id) on delete cascade,
  "brandId"      text        not null references brands(id),
  "thresholdMet" integer     not null,                        -- cumulative badge count that unlocked it
  status         text        not null default 'pending' check (status in ('pending','fulfilled')),
  code           text        not null,
  "createdAt"    timestamptz not null default now(),
  "fulfilledAt"  timestamptz,
  "fulfilledBy"  text                                         -- staff username
);

create index if not exists reward_redemptions_customer_idx
  on reward_redemptions ("customerId");
create index if not exists reward_redemptions_brand_status_idx
  on reward_redemptions ("brandId", status);

alter table reward_redemptions enable row level security;

drop policy if exists reward_redemptions_select_own on reward_redemptions;
create policy reward_redemptions_select_own on reward_redemptions
  for select to authenticated using ("customerId" = auth.uid());

-- ── claim_redemption_code(p_code) ──────────────────────────────────────────
-- The atomic loyalty transaction: validate code → claim it → grant badges →
-- create any newly-unlocked rewards. SECURITY DEFINER so it can touch tables
-- the caller has no policies for; per-customer row lock serializes concurrent
-- claims so the threshold-crossing math can't double-create rewards.

create or replace function claim_redemption_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_norm     text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  v_code     redemption_codes%rowtype;
  v_config   reward_config%rowtype;
  v_before   integer;
  v_total    integer;
  v_unlocked jsonb := '[]'::jsonb;
  v_rid      text;
  v_rcode    text;
  i          integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  -- lock the code row: two racing claims of the same code serialize here
  select * into v_code from redemption_codes where upper(code) = v_norm for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;
  if v_code.status <> 'unclaimed' then
    return jsonb_build_object('ok', false,
      'error', case when v_code."claimedBy" = v_uid then 'already_claimed_by_you' else 'already_claimed' end);
  end if;

  -- make sure the profile row exists, then lock it: serializes concurrent
  -- claims of DIFFERENT codes by the same customer (threshold math below
  -- reads a count, so unserialized claims could double-create a reward)
  insert into customers (id, "brandId", email)
    values (v_uid, v_code."brandId", (select u.email from auth.users u where u.id = v_uid))
    on conflict (id) do nothing;
  perform 1 from customers where id = v_uid for update;

  select count(*) into v_before from badge_events
    where "customerId" = v_uid and "brandId" = v_code."brandId";

  update redemption_codes
    set status = 'claimed', "claimedBy" = v_uid, "claimedAt" = now()
    where id = v_code.id;

  for i in 1 .. v_code."badgeCount" loop
    insert into badge_events (id, "customerId", "sourceCodeId", "brandId")
      values ('be_' || replace(gen_random_uuid()::text, '-', ''), v_uid, v_code.id, v_code."brandId");
  end loop;

  v_total := v_before + v_code."badgeCount";

  select * into v_config from reward_config
    where "brandId" = v_code."brandId" and active;
  if found then
    -- one reward per threshold multiple crossed in (v_before, v_total]
    for i in (v_before / v_config.threshold) + 1 .. (v_total / v_config.threshold) loop
      v_rid   := 'rr_' || replace(gen_random_uuid()::text, '-', '');
      v_rcode := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      insert into reward_redemptions (id, "customerId", "brandId", "thresholdMet", code)
        values (v_rid, v_uid, v_code."brandId", i * v_config.threshold, v_rcode);
      v_unlocked := v_unlocked || jsonb_build_object(
        'id', v_rid, 'code', v_rcode, 'thresholdMet', i * v_config.threshold,
        'rewardTitle', v_config."rewardTitle", 'rewardDetail', v_config."rewardDetail");
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'granted', v_code."badgeCount",
    'totalBadges', v_total,
    'threshold', case when v_config."brandId" is null then null else v_config.threshold end,
    'unlocked', v_unlocked);
end
$$;

-- default PUBLIC execute would let the anon key probe codes — lock it down
revoke all on function claim_redemption_code(text) from public;
revoke all on function claim_redemption_code(text) from anon;
grant execute on function claim_redemption_code(text) to authenticated;
grant execute on function claim_redemption_code(text) to service_role;

insert into applied_migrations (id) values ('0034_bae_loyalty')
  on conflict (id) do nothing;
