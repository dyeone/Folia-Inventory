// User roles (2026-10-02). Mirrors api/_lib/supabase.js ROLES — keep the two
// identical.
//
//   admin       the full app, every tab, every action
//   teammember  the packing bench only (pack, wrap, label, count in wholesale
//               deliveries, slips); never sees a price. Formerly 'packer'.
//   consultant  the mobile wholesale-pricing screen (list price + seller
//               note); never sees a cost.
//
// 'staff' no longer exists. The API reads old rows ('packer', 'staff') under
// the new names until migration 0048 renames them; normalizeRole does the
// same for anything cached on this side.
export const ROLES = [
  { id: 'admin', label: 'Admin', hint: 'full access' },
  { id: 'teammember', label: 'Team member', hint: 'packing bench only — pack, wrap, label, receive; no prices' },
  { id: 'consultant', label: 'Consultant', hint: 'wholesale pricing only (list price + seller note, mobile)' },
];
export const DEFAULT_NEW_ROLE = 'teammember';

export function normalizeRole(role) {
  if (role === 'packer' || role === 'staff') return 'teammember';
  return role;
}

export function roleLabel(role) {
  return ROLES.find((r) => r.id === normalizeRole(role))?.label || String(role || '');
}
