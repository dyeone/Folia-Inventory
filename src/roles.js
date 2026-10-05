// User roles (2026-10-04). Mirrors api/_lib/supabase.js ROLES — keep the two
// identical.
//
//   admin       the full app, every tab, every action
//   packer      the packing bench only: shipping, wrapping, labels, wholesale
//               receiving, TC acclimation. Never sees a price.
//   streamer    the mobile streamer screen: weekly availability (by the
//               hour), the published schedule, and the available inventory
//               with list prices and the consultant's sell notes. Never
//               sees a cost.
//   consultant  the mobile wholesale-pricing screen (list price + seller
//               note); never sees a cost.
//
// 'teammember' (2026-10-02) and 'staff' no longer exist. The API reads old
// rows under the new names until migration 0049 renames them; normalizeRole
// does the same for anything cached on this side.
export const ROLES = [
  { id: 'admin', label: 'Admin', hint: 'full access' },
  { id: 'packer', label: 'Packer', hint: 'packing bench only — shipping, labels, receiving, TC acclimation; no prices' },
  { id: 'streamer', label: 'Streamer', hint: 'availability, schedule, available inventory with list prices + sell notes' },
  { id: 'consultant', label: 'Consultant', hint: 'wholesale pricing only (list price + seller note, mobile)' },
];
export const DEFAULT_NEW_ROLE = 'packer';

export function normalizeRole(role) {
  if (role === 'teammember' || role === 'staff') return 'packer';
  return role;
}

export function roleLabel(role) {
  return ROLES.find((r) => r.id === normalizeRole(role))?.label || String(role || '');
}
