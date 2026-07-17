-- 0036 · Connect the BAE app to the shipping system: full order history.
--
-- Until now the app's Orders tab only showed boxes the customer had SCANNED
-- (customer_orders rows written by the claim RPC). This migration links a
-- customer to their Palmstreet buyer identity and syncs their complete
-- shipping history:
--
--   1. Claiming a slip code is proof of identity — the physical slip only
--      travels inside that buyer's box. sync_customer_orders() derives
--      customers."verifiedBuyers" (lowercased) from the boxes of EVERY code
--      the customer has claimed, on every run — self-healing, so claims
--      that happened before this migration verify retroactively.
--   2. The same RPC (called by the app's Orders tab and by claim v3 itself)
--      upserts one customer_orders row per shipped box belonging to any
--      verified buyer — items snapshot + tracking number + carrier from the
--      shipments table. Re-running refreshes tracking.
--
-- The v1/v2 decision stands: identity is NEVER inferred from a typed
-- username — it is only ever derived from a claimed slip. Customers still
-- have no read access to inventory_items or shipments; both RPCs are
-- SECURITY DEFINER. Addresses are never copied into customer-visible rows.
--
-- Depends on 0035 (replaces its claim RPC). Idempotent.

-- ── customers: verified buyer identities ───────────────────────────────────

alter table customers add column if not exists "verifiedBuyers" text[] not null default '{}';

-- ── customer_orders: shipping fields, synced rows have no code ─────────────

alter table customer_orders alter column "sourceCodeId" drop not null;
alter table customer_orders add column if not exists "trackingNumber" text;
alter table customer_orders add column if not exists carrier text;
alter table customer_orders add column if not exists "shippedAt" timestamptz;

-- One row per box per customer, whether it arrived via claim or via sync.
-- (Safe on existing data: the claim path can't duplicate — one code per box,
-- one row per code.)
create unique index if not exists customer_orders_customer_box_unique
  on customer_orders ("customerId", "shipmentBoxId");

-- The sync sweeps inventory_items by buyer username.
create index if not exists inventory_items_buyer_username_lower_idx
  on inventory_items (lower("buyerUsername")) where "buyerUsername" is not null;

-- ── sync_customer_orders ────────────────────────────────────────────────────
-- Upsert the caller's full shipping history from their verified buyers.
-- A box counts as an order once it shipped OR has a live (un-voided) label.
-- Conflicts refresh tracking/carrier/shippedAt but never rewrite the items
-- snapshot of a claimed row.

create or replace function sync_customer_orders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_buyers      text[];
  v_code_buyers text[];
  v_brand       text;
  v_added       integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select "verifiedBuyers", "brandId" into v_buyers, v_brand
    from customers where id = v_uid;
  if v_brand is null then
    return jsonb_build_object('ok', true, 'added', 0);
  end if;

  -- self-healing: (re)derive verified buyers from every code this customer
  -- has claimed — covers claims made before this migration existed and
  -- boxes whose buyer data landed after the claim
  select array_agg(distinct lower(trim(i."buyerUsername"))) into v_code_buyers
  from redemption_codes rc
  join inventory_items i
    on i."shipmentBoxId" = rc."shipmentBoxId"
   and i."brandId" = rc."brandId"
  where rc."claimedBy" = v_uid
    and i."deletedAt" is null
    and nullif(trim(i."buyerUsername"), '') is not null;

  v_buyers := (
    select coalesce(array_agg(distinct u), '{}')
    from unnest(coalesce(v_buyers, '{}') || coalesce(v_code_buyers, '{}')) as t(u));

  if coalesce(array_length(v_buyers, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'added', 0);
  end if;

  update customers set "verifiedBuyers" = v_buyers
    where id = v_uid and "verifiedBuyers" is distinct from v_buyers;

  with boxes as (
    select
      i."shipmentBoxId" as box,
      coalesce(jsonb_agg(jsonb_build_object(
        'sku', i.sku, 'name', i.name, 'variety', i.variety,
        'quantity', greatest(coalesce(i.quantity, 1), 1)) order by i.sku), '[]'::jsonb) as items,
      coalesce(max(i."orderDate"), max(i."shippedAt"), now()) as ordered,
      max(i."shippedAt") as shipped
    from inventory_items i
    where i."brandId" = v_brand
      and i."buyerUsername" is not null
      and lower(i."buyerUsername") = any (v_buyers)
      and i."shipmentBoxId" is not null
      and i."deletedAt" is null
    group by i."shipmentBoxId"
  ),
  enriched as (
    select b.box, b.items, b.ordered, b.shipped,
           s."trackingNumber" as tracking, s.carrier
    from boxes b
    left join shipments s on s.id = b.box and s."voidedAt" is null
    where b.shipped is not null or s."trackingNumber" is not null
  ),
  upserted as (
    insert into customer_orders
      (id, "customerId", "brandId", "shipmentBoxId", items, "orderedAt",
       "trackingNumber", carrier, "shippedAt")
    select
      'co_' || replace(gen_random_uuid()::text, '-', ''),
      v_uid, v_brand, e.box, e.items, e.ordered, e.tracking, e.carrier, e.shipped
    from enriched e
    on conflict ("customerId", "shipmentBoxId") do update
      set "trackingNumber" = excluded."trackingNumber",
          carrier          = excluded.carrier,
          "shippedAt"      = excluded."shippedAt"
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_added from upserted;

  return jsonb_build_object('ok', true, 'added', v_added);
end
$$;

revoke all on function sync_customer_orders() from public;
revoke all on function sync_customer_orders() from anon;
grant execute on function sync_customer_orders() to authenticated;
grant execute on function sync_customer_orders() to service_role;

-- ── claim_redemption_code v3 ───────────────────────────────────────────────
-- v2 (0035) plus: after claiming, run sync_customer_orders() — the sync
-- derives the verified buyer identity from the just-claimed code and pulls
-- the buyer's full shipping history. The order-snapshot insert now
-- conflicts on (customerId, shipmentBoxId) so a claim can attach its code
-- to a row the sync created earlier. Returns 'ordersAdded' — how many past
-- orders the sync just pulled in.

create or replace function claim_redemption_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_norm         text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  v_code         redemption_codes%rowtype;
  v_config       reward_config%rowtype;
  v_before       integer;
  v_total        integer;
  v_unlocked     jsonb := '[]'::jsonb;
  v_rid          text;
  v_rcode        text;
  v_refs         text[];
  v_items        jsonb;
  v_ordered      timestamptz;
  v_sync         jsonb;
  v_orders_added integer := 0;
  i              integer;
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
    coalesce(max("orderDate"), max("shippedAt"))
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
    on conflict ("customerId", "shipmentBoxId") do update
      set "sourceCodeId" = coalesce(customer_orders."sourceCodeId", excluded."sourceCodeId"),
          items          = excluded.items,
          "orderedAt"    = excluded."orderedAt";

  -- the slip proves this customer IS the box's buyer: the sync derives the
  -- verified identity from the just-claimed code and backfills history
  v_sync := sync_customer_orders();
  v_orders_added := coalesce((v_sync ->> 'added')::integer, 0);

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
    'unlocked', v_unlocked,
    'ordersAdded', v_orders_added);
end
$$;

-- grants are per-signature; re-assert so the migration stands alone.
revoke all on function claim_redemption_code(text) from public;
revoke all on function claim_redemption_code(text) from anon;
grant execute on function claim_redemption_code(text) to authenticated;
grant execute on function claim_redemption_code(text) to service_role;

insert into applied_migrations (id) values ('0036_bae_order_sync')
  on conflict (id) do nothing;
