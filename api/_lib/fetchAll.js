// Every row a select matches, past PostgREST's row cap.
//
// Supabase answers one select with at most 1000 rows and says nothing about
// the rest. Lists that outgrew that silently lost rows: on 2026-11-13 BAE had
// 1,045 box settings and 1,003 label rows, so box-notes served 1,000 and
// dropped a "Local pickup" flag set that morning (the flag "didn't stick"),
// and the Shipping tab lost three bought UPS labels.
//
// Pages are keyed on `id` (ordered by it, then `id > last`), not offsets: an
// unordered select returns rows in storage order, and Postgres writes an
// updated row to a new spot, so offset pages over a table that changes while
// it's read skip some rows and repeat others. `id` never changes, so every
// row is read exactly once.
//
// buildQuery returns a FRESH filtered select that includes `id` and has no
// .order()/.range()/.limit() of its own (a query builder can only run once).
export async function fetchAllById(buildQuery, pageSize = 1000) {
  const rows = [];
  let last = null;
  for (;;) {
    let q = buildQuery().order('id', { ascending: true }).limit(pageSize);
    if (last !== null) q = q.gt('id', last);
    const { data, error } = await q;
    if (error) {
      const e = new Error(error.message);
      e.status = 500;
      throw e;
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
    last = page[page.length - 1].id;
  }
}
