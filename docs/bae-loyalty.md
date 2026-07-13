# BAE loyalty — badges (数字徽章), rewards + customer hub

> Status: v1 loop shipped (PR #86); v2 customer hub built on top (migration 0035).
> Awaiting: migrations 0034 + 0035 applied + Supabase Auth email setup.
> Design doc: `~/Projects/bae-loyalty-app/DESIGN.md` (approved, /office-hours 2026-07-12).
> Customer app: separate Expo repo at `~/Projects/bae-loyalty-app` ("BAE Badges").

## v2 — customer hub (migration 0035)

The app grows from a punch card into BAE's customer surface; the Loyalty tab
grows into customer management. Three additions, all riding the same
two-audience architecture:

- **Shopping history** — `customer_orders`, one row per *claimed* code. The
  claim RPC snapshots the box's plants ({sku, name, variety, quantity}) at
  claim time, so customers never read `inventory_items` and later inventory
  edits can't rewrite history. Derived from scans (verified purchases), NOT
  Palmstreet-username matching — same decision as v1 codes.
- **Collection gallery** — `badge_events."plantRef"` is now populated at claim
  (plant name, multi-quantity lots expanded), so badges group by species.
- **News + growing tips** — `customer_content` (kind 'news'|'tip'), authored
  by admins in the Loyalty tab's **Content** section, read by the app via RLS
  (active rows only). The Loyalty tab also gains a **Customers** section:
  every app customer with badge/order/reward counts and contact info.

App IA: Home (feed + reward banner + progress) · Badges (ring + collection) ·
Scan · Orders · Profile; Rewards is a stack screen reachable from Home/Badges/
the unlock moment.

## The loop

```
pack a BAE box ──▶ slip prints with QR + short code   (this repo)
                              │
        customer scans it in the BAE Badges app       (bae-loyalty-app repo)
                              │
        claim_redemption_code() RPC — atomic:          (Supabase, migration 0034)
        validate → claim → +1 badge per plant
                              │
        badges cross threshold ──▶ reward_redemptions row + in-app reward code
                              │
        customer shows the code ──▶ staff verify + "Fulfilled"
                                     (BAE ▸ Loyalty admin tab, this repo)
```

## Two audiences, two auth systems (deliberate)

| | Staff (this app) | Customers (BAE Badges app) |
|---|---|---|
| Auth | custom `users` table | **Supabase Auth** (email OTP) |
| Data path | Vercel `/api` + service key (bypasses RLS, scoped in code) | Supabase directly, **real RLS policies** |
| Why | unchanged | `/api` is at the 12-function Hobby cap and must not carry customer traffic |

The customer-facing tables (`customers`, `badge_events`, `reward_config`,
`reward_redemptions`) carry actual RLS policies for the `authenticated` role —
each customer sees only their own rows. `redemption_codes` has RLS enabled
with **no policies** so codes can never be enumerated; the only claim path is
the `SECURITY DEFINER` RPC.

## Pieces in this repo

- **`supabase/migrations/0034_bae_loyalty.sql`** — the 5 tables, RLS policies,
  BAE `reward_config` seed (threshold 10), and the `claim_redemption_code(p_code)`
  RPC. Mirrored into `schema.sql`. Apply manually (SQL editor), like every migration.
- **`api/shipments.js` → `action: 'loyalty-code'`** — get-or-create the code for
  a box. Called by the slip printer right before rendering a BAE slip, so the
  code exists before it's printed. Idempotent per box (unique index on
  `shipmentBoxId`); while unclaimed, `badgeCount` is refreshed from current box
  contents on each print. BAE-only; 503 with a clear message if 0034 isn't applied.
- **`src/labels/ShippingSlipSheet.jsx`** — BAE slips grow a "BAE BADGES" block:
  26mm QR (the bare code) + `XXXX-XXXX` short code + badge count. Folia slips are
  untouched. If the loyalty API is unreachable (or un-migrated), the slip prints
  without the block after an 8s timeout — printing is never blocked.
- **`api/settings.js` → `loyalty-*` actions** — `loyalty-get` (config + stats),
  `loyalty-save` (admin), `loyalty-redemptions` (list w/ customer contact),
  `loyalty-fulfill` (admin, undo-able).
- **`src/loyalty/LoyaltyAdmin.jsx`** — the BAE ▸ **Loyalty** tab (admin-only):
  punch-card config, program stats, pending/fulfilled reward list.

## First-deploy checklist

1. Apply `supabase/migrations/0034_bae_loyalty.sql` in the Supabase SQL editor.
2. Supabase Dashboard → Authentication: enable the **Email** provider, then
   edit **both** the **Magic Link** AND **Confirm signup** email templates to
   include `{{ .Token }}` — the defaults only send a login link, but the app
   asks the customer to type a 6-digit code, and Supabase uses Confirm signup
   for a customer's FIRST sign-in (Magic Link for returning ones). Before real
   customers: set custom SMTP (Authentication → Emails → SMTP Settings, e.g.
   Resend) — the built-in sender allows only a few emails/hour. (Phone OTP =
   later, needs Twilio.)
3. Deploy this repo to Vercel as usual (no new functions, no new env vars).
4. In the app: BAE brand → **Loyalty** tab → set the real reward text +
   threshold (seeded: 10 → "Free BAE anthurium" placeholder).
5. Customer app: see `~/Projects/bae-loyalty-app/README.md` — it needs
   `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_ANON_KEY` (the same anon
   key the web app uses for realtime; RLS makes it safe), then EAS build/submit.
6. Print a test BAE slip, scan it in the app, watch the badge land, then undo
   nothing — codes are single-claim by design.

## Decisions log

- **One code per box** (not per plant): v1 punch-card granularity, per DESIGN.md.
  `badgeCount` = plants in the box (sum of `quantity`, excluding deleted).
  UNMATCHED-* placeholders **count** — they're real shipped plants whose SKU
  didn't match, and the slip lists them as ordinary items next to "1 badge
  per plant".
- **No retroactive codes**: a new code is only minted while the box is un- or
  recently-shipped (48h grace). Pre-launch boxes can't be harvested for
  claimable codes by staff; existing codes still return forever (reprints).
- **RPC over Edge Function** for the atomic claim: DESIGN.md allowed either; the
  repo has no Edge Function infra or Supabase CLI, and a `SECURITY DEFINER`
  plpgsql function gets transactional atomicity for free. Per-customer row lock
  serializes concurrent claims so threshold math can't double-create rewards.
- **Code format**: 8 chars, alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no
  0/O/1/I/L — hand-typable off a thermal slip), stored canonical, printed
  dash-grouped. QR encodes the bare code string.
- **Push notifications on unlock**: v1 uses a local notification fired by the
  app when the claim response includes an unlock. Real server push (Expo push
  tokens) is a v2 item.
- **Historical purchases** don't earn badges (code-on-slip only credits go-forward),
  accepted in DESIGN.md; a backfill campaign is a possible later batch job.
