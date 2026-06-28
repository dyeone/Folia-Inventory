# 3babes — multi-brand architecture

> Status: Stages 1–3 done; Stage 4 in progress (branch `feat/3babes-multi-brand`).
> Done: foundation + migrations 0029/0030, all 12 API functions brand-scoped,
> 3babes shell + Folia/BAE switcher, and per-user brand assignment in user
> management. Remaining: live BAE dogfood (needs migrations applied) + Stage 5
> (bridge/mac-app/extension brand routing).
> Goal: turn the single-tenant **Folia** app into a **3babes** house that runs
> multiple brands from one codebase + one Supabase, starting with **Folia** and
> **BAE** (Best Anthuriums Ever). Each brand's operational data is fully
> separate; the software/features are shared.

## The shape

```
            3babes  (the company / app shell — the "outer frame")
             /                         \
          FOLIA                        BAE
   (plant inventory, live)     (Best Anthuriums Ever)
             \                         /
        ONE codebase  +  ONE Supabase project
        every brand-scoped row carries a brandId
        a brand switcher picks the active brand
```

- **3babes** is the app itself (the shell, login, brand switcher). One company
  today, so there is **no `companies` table** — a `brands` table is enough. Add
  a company layer later only if a second company appears (YAGNI).
- **Folia** and **BAE** are rows in `brands`. Existing Folia data backfills to
  the `folia` brand, so nothing changes for Folia.
- Users belong to 3babes and carry a **`brandIds`** access list. The owner gets
  all brands and can switch; brand-specific staff (e.g. a BAE packer) get only
  their brand.

## Data model

New table:

```
brands(id text pk, slug, name, createdAt)   -- seeded: 'folia', 'bae'
```

`brandId text references brands(id)` added to every **brand-scoped** table and
backfilled to `'folia'`:

> inventory_items · sales · varieties · species · species_photos ·
> purchase_orders · purchase_order_lines · purchase_order_received_items ·
> shipments · shipment_boxes · bridge_jobs · sale_evaluations

**Global (not brand-scoped):**

- `users` — belong to 3babes; gain `brandIds text[]` (the access list). A user
  may see one or many brands.
- `auth_attempts` — login security, global.
- `app_settings` — key→JSON store. Gets a **nullable** `brandId`:
  `NULL` = global setting (e.g. ShipStation API config), a brand id = per-brand
  setting (e.g. the box-size catalog). Per-user task blobs (`tasks:<userId>`)
  stay global. The settings endpoint decides per key.

**SKU numbering becomes per-brand.** Today numbering is global
(`inventory_max_sku_suffix()`); each brand needs its own sequence and its own
variety codes/prefixes. The RPC gains a brand argument (Stage 2).

## How a brand reaches the server

The frontend already funnels every authed call through one `request()` in
`src/api.js` that appends `userId`. The active **`brandId`** rides along the
exact same way (query param on GET, body field on POST). Server-side, each of
the 12 functions already calls `requireUser(userId)`; it gains a sibling
`requireBrand(userId, brandId)` that:

1. resolves the brand (defaults to `folia` when absent — so the current Folia
   frontend keeps working untouched until the switcher ships),
2. verifies `brandId ∈ user.brandIds`,
3. returns `{ user, brand }`.

Every query then filters `.eq('brandId', brand.id)` and every insert sets it.
The service-role key bypasses RLS, so **scoping is enforced in code** — the same
trust model as today.

## Rollout stages (Folia must never break)

1. **Foundation** *(this stage)* — `brands` table, `brandId` columns +
   backfill to folia, `users.brandIds`, and the `requireBrand` helper. Pure
   additive migration; nothing is wired to send a brand yet, so Folia is
   unaffected. *Apply migration `0029` once per environment.*
2. **Scope the API** — thread `brandId` through all 12 functions, defaulting to
   folia. Per-brand SKU RPC. Folia still works because everything defaults to
   folia.
3. **Frontend frame** — 3babes shell, `BrandContext`, brand switcher (only the
   user's brands), `request()` sends the active brand, per-brand theming.
4. **Enable BAE** — grant the owner both brands, BAE branding, seed BAE
   varieties/species, end-to-end test BAE, regression-test Folia.
5. **Bridge / mac-app / extension** — brand-scope `bridge_jobs` and
   printing/scanning so the local bridge + Chrome extension work per brand.

## Safety notes

- The 12-function Vercel cap is **not** affected: tenancy adds columns and
  query filters, not new functions.
- Migrations are applied manually (Supabase SQL editor) and are idempotent.
  Claude writes them; the operator runs them. Every brand-scoped column is added
  nullable → backfilled → set NOT NULL, so a half-applied state can't orphan
  rows.
- Until Stage 3 ships the switcher, the app behaves exactly like Folia.
