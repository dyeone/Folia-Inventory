-- 0035 · BAE customer hub: shopping history, per-plant badges, news & tips.
--
-- v2 of the loyalty program (0034): the BAE Badges app grows from a punch
-- card into a customer hub. Three additions:
--
--   1. customer_orders — the customer's shopping history, derived from
--      CLAIMED codes (scan = verified purchase; same decision as 0034 —
--      no Palmstreet-username matching). The claim RPC snapshots the box's
--      plants into one row at claim time, so customers never need (and
--      never get) read access to inventory_items.
--   2. badge_events."plantRef" now POPULATED at claim time (one ref per
--      plant, multi-quantity lots expanded) → the app can render a
--      per-species collection gallery.
--   3. customer_content — BAE news + growing tips, authored by staff in
--      the admin app (service role), read by customers via RLS.
--
-- Depends on 0034 (apply 0034 first — this replaces its claim RPC).
-- Idempotent.

-- ── customer_orders ────────────────────────────────────────────────────────
-- One row per claimed code = one shipped box. `items` is a point-in-time
-- snapshot [{sku, name, variety, quantity}] taken by the RPC, so later
-- inventory edits never rewrite a customer's history.

create table if not exists customer_orders (
  id              text        primary key,                    -- 'co_' + random
  "customerId"    uuid        not null references customers(id) on delete cascade,
  "brandId"       text        not null references brands(id),
  "sourceCodeId"  text        not null references redemption_codes(id),
  "shipmentBoxId" text        not null,
  items           jsonb       not null default '[]'::jsonb,
  "orderedAt"     timestamptz not null default now(),         -- best-effort: max shippedAt of the box
  "createdAt"     timestamptz not null default now()
);

create unique index if not exists customer_orders_code_unique
  on customer_orders ("sourceCodeId");
create index if not exists customer_orders_customer_idx
  on customer_orders ("customerId", "brandId", "orderedAt" desc);

alter table customer_orders enable row level security;

drop policy if exists customer_orders_select_own on customer_orders;
create policy customer_orders_select_own on customer_orders
  for select to authenticated using ("customerId" = auth.uid());
-- no insert/update policies: rows are only written by the claim RPC

-- ── customer_content ───────────────────────────────────────────────────────
-- News + growing tips. Staff author via the admin app (service role bypasses
-- RLS); customers read published rows directly. `active` is the publish
-- switch; `publishedAt` orders the feed.

create table if not exists customer_content (
  id            text        primary key,                      -- 'cc_' + random
  "brandId"     text        not null references brands(id),
  kind          text        not null check (kind in ('news','tip')),
  title         text        not null,
  body          text        not null,
  "imageUrl"    text,
  "publishedAt" timestamptz not null default now(),
  active        boolean     not null default true,
  "createdAt"   timestamptz not null default now(),
  "createdBy"   text,
  "updatedAt"   timestamptz,
  "updatedBy"   text
);

create index if not exists customer_content_feed_idx
  on customer_content ("brandId", kind, "publishedAt" desc);

alter table customer_content enable row level security;

-- Deliberately NOT brand-tied: published brand content is marketing copy (the
-- landing site already serves it world-readable via landing-public), and each
-- brand's app filters by its own brandId. If a brand ever needs PRIVATE
-- announcements, tighten to:
--   using (active and "brandId" in (select "brandId" from customers where id = auth.uid()))
drop policy if exists customer_content_select_published on customer_content;
create policy customer_content_select_published on customer_content
  for select to authenticated using (active);

-- ── claim_redemption_code v2 ───────────────────────────────────────────────
-- Same atomic claim as 0034, plus: snapshot the box's plants into
-- customer_orders and stamp each badge with the plant it came from.
-- Multi-quantity lots expand (quantity 3 → 3 refs). If the box's current
-- items disagree with the code's badgeCount (box edited after print), the
-- code's badgeCount stays authoritative for GRANTS; refs cover what they can
-- and the rest stay null.

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
  v_refs     text[];
  v_items    jsonb;
  v_ordered  timestamptz;
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

  -- make sure the profile row exists, then lock it (serializes concurrent
  -- claims of different codes by the same customer for the threshold math)
  insert into customers (id, "brandId", email)
    values (v_uid, v_code."brandId", (select u.email from auth.users u where u.id = v_uid))
    on conflict (id) do nothing;
  perform 1 from customers where id = v_uid for update;

  select count(*) into v_before from badge_events
    where "customerId" = v_uid and "brandId" = v_code."brandId";

  update redemption_codes
    set status = 'claimed', "claimedBy" = v_uid, "claimedAt" = now()
    where id = v_code.id;

  -- snapshot the box's plants: order history + per-badge refs
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'sku', sku, 'name', name, 'variety', variety,
      'quantity', greatest(coalesce(quantity, 1), 1)) order by sku), '[]'::jsonb),
    max("shippedAt")
  into v_items, v_ordered
  from inventory_items
  where "shipmentBoxId" = v_code."shipmentBoxId"
    and "brandId" = v_code."brandId"
    and "deletedAt" is null;

  select array_agg(ref) into v_refs from (
    select coalesce(nullif(trim(name), ''), nullif(trim(variety), ''), sku) as ref
    from inventory_items,
         generate_series(1, greatest(coalesce(quantity, 1), 1))
    where "shipmentBoxId" = v_code."shipmentBoxId"
      and "brandId" = v_code."brandId"
      and "deletedAt" is null
  ) t;

  for i in 1 .. v_code."badgeCount" loop
    insert into badge_events (id, "customerId", "sourceCodeId", "plantRef", "brandId")
      values (
        'be_' || replace(gen_random_uuid()::text, '-', ''),
        v_uid, v_code.id,
        case when v_refs is not null and i <= array_length(v_refs, 1) then v_refs[i] else null end,
        v_code."brandId");
  end loop;

  insert into customer_orders (id, "customerId", "brandId", "sourceCodeId", "shipmentBoxId", items, "orderedAt")
    values (
      'co_' || replace(gen_random_uuid()::text, '-', ''),
      v_uid, v_code."brandId", v_code.id, v_code."shipmentBoxId",
      coalesce(v_items, '[]'::jsonb), coalesce(v_ordered, now()))
    on conflict ("sourceCodeId") do nothing;

  v_total := v_before + v_code."badgeCount";

  select * into v_config from reward_config
    where "brandId" = v_code."brandId" and active;
  if found then
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

-- grants are per-signature and 0034 already revoked/granted this signature;
-- re-assert so the migration stands alone on a fresh-but-0034-applied DB.
revoke all on function claim_redemption_code(text) from public;
revoke all on function claim_redemption_code(text) from anon;
grant execute on function claim_redemption_code(text) to authenticated;
grant execute on function claim_redemption_code(text) to service_role;

insert into applied_migrations (id) values ('0035_bae_customer_hub')
  on conflict (id) do nothing;
