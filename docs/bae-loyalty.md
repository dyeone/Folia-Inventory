# BAE loyalty — badges (数字徽章), rewards + customer hub

> Status: v1 loop shipped (PR #86); v2 customer hub built on top (migration 0035);
> v3 app auth: email+password + Apple/Google, slip-code-gated registration;
> v4 shipping-linked order history (migration 0036).
> Applied in prod: 0034 + 0035. Awaiting: 0036 + Supabase Auth provider setup.
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
  Palmstreet-username matching — same decision as v1 codes. (v4 extends the
  *display*: after one verified scan, that buyer's full history syncs in —
  but identity itself is still only ever proven by a physical slip.)
- **Collection gallery** — `badge_events."plantRef"` is now populated at claim
  (plant name, multi-quantity lots expanded), so badges group by species.
- **News + growing tips** — `customer_content` (kind 'news'|'tip'), authored
  by admins in the Loyalty tab's **Content** section, read by the app via RLS
  (active rows only). The Loyalty tab also gains a **Customers** section:
  every app customer with badge/order/reward counts and contact info.

App IA: Home (feed + reward banner + progress) · Badges (ring + collection) ·
Scan · Orders · Profile; Rewards is a stack screen reachable from Home/Badges/
the unlock moment.

## v3 — app sign-in: password + Apple/Google, slip-code registration

All in the app repo (no server/API changes here). Email OTP login is replaced:

- **Create account** = email + password + **the slip code** (printed under the
  QR). The code is parked locally, the email is verified with a 6-digit code
  (Confirm signup template), then the **claim-gate** screen claims it — one
  claim path for every flow.
- **Sign in** = email + password, with a code-based **Forgot password** reset
  (Reset Password template needs `{{ .Token }}` too).
- **Apple / Google** sign-in on both screens. Social accounts skip the code
  field but land on the claim-gate: *every* account must claim one slip code
  (≥1 `badge_events` row) before entering the app. Soft gate by design — the
  claim RPC is the real protection; the gate fails open on network errors so
  a flaky connection never locks a real customer out.

Dashboard setup (one-time, in addition to the email templates below):

- **Apple**: Auth → Providers → Apple → enable, and under **Client IDs** add
  `com.threebabes.baebadges` (standalone build) *and* `host.exp.Exponent`
  (Expo Go dev — its entitlement signs the token). Native flow: no secret.
- **Google**: Google Cloud Console → OAuth **web** client with redirect URI
  `https://smymisjjlprrhnfzrgfo.supabase.co/auth/v1/callback`; paste client ID
  + secret into Auth → Providers → Google.
- **Redirect URLs** (Auth → URL Configuration): add `baebadges://**` (builds)
  and `exp://**` (Expo Go dev) so the Google flow may return to the app.
- Recommended: leave **Confirm email** ON (the register flow handles both).

## v4 — shipping-linked order history (migration 0036)

The Orders tab shows the customer's FULL shipping history, not just scanned
boxes. The link is earned, never typed:

- Claiming a slip code is proof of identity (the slip travels inside that
  buyer's box) — claim v3 records the box's `buyerUsername` into
  `customers."verifiedBuyers"` (lowercased).
- `sync_customer_orders()` (SECURITY DEFINER, called by the app's Orders tab
  on load and by the claim itself) upserts one `customer_orders` row per
  shipped box of any verified buyer: items snapshot + `trackingNumber` +
  `carrier` from the `shipments` table. Re-runs refresh tracking; a claimed
  row's snapshot is never rewritten. "Shipped" = `shippedAt` set OR a live
  (un-voided) label exists.
- `customer_orders."sourceCodeId"` is now nullable (synced rows have no
  code); a second unique key on `("customerId","shipmentBoxId")` is added (the
  per-code unique key stays). Addresses are never copied into customer-visible
  rows; customers still can't read `inventory_items` or `shipments`.
- `customers."verifiedBuyers"` is a definer-only cache: `UPDATE` on it is
  revoked from `authenticated`, and sync recomputes it from claimed codes
  every run — the stored value is never trusted as an identity input.
- The claim result gains `ordersAdded` — the app's gate says "we also found
  N past orders".

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
| Auth | custom `users` table | **Supabase Auth** (email+password, Apple, Google) |
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

1. Apply `supabase/migrations/0034_bae_loyalty.sql`, then `0035_bae_customer_hub.sql`,
   then `0036_bae_order_sync.sql` in the Supabase SQL editor (0034 + 0035 are
   already applied in prod as of 2026-07-13).
2. Supabase Dashboard → Authentication: enable the **Email** provider, then
   add `{{ .Token }}` to the **Confirm signup**, **Reset Password**, and
   **Magic Link** email templates — the defaults only send a link, but the app
   asks the customer to type a 6-digit code (Confirm signup verifies new
   accounts; Reset Password powers "Forgot password?"). Then do the v3
   provider setup above (Apple client IDs, Google OAuth client, redirect
   URLs). Before real customers: set custom SMTP (Authentication → Emails →
   SMTP Settings, e.g. Resend) — the built-in sender allows only a few
   emails/hour. (Phone OTP = later, needs Twilio.)
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
