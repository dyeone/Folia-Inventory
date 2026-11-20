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

// The rows of fetchAllById, for wide rows read often — the full plant list is
// ~7,000 rows / ~9 MB per brand, read on every app load and every 8 s by the
// Shipping tab and the packer bench. fetchAllById fetches it as 1,000-row
// pages one after another (about 3 s); here only the ids go page by page
// (small pages), then the full rows of every id range load at once.
//
// build(columns) returns a FRESH select of those columns with the filters
// applied (no .order()/.range()/.limit()) — the same filters for both passes.
//
// Still each row exactly once and no offsets: the ranges split the whole id
// line at ids from the first pass (the first has no lower end, the last no
// upper end, each next one starts where the one before stops), and a range
// that has grown past a page since keeps paging on id inside its bounds. A
// row deleted in between is absent; a row added in between lands in exactly
// one range and is read.
const PAGE_CAP = 1000;   // PostgREST answers at most this many rows per select
export async function fetchWideById(build, rangeSize = 800) {
  const ids = (await fetchAllById(() => build('id'), PAGE_CAP)).map(r => r.id);
  if (!ids.length) return [];
  // Range i is [cuts[i-1], cuts[i]) — from >= the cut before, to < the next.
  const cuts = [];
  for (let i = rangeSize; i < ids.length; i += rangeSize) cuts.push(ids[i]);
  const ranges = [...cuts, null].map((to, i) => ({ from: i ? cuts[i - 1] : null, to }));
  const parts = await Promise.all(ranges.map(async ({ from, to }) => {
    const rows = [];
    let after = null;
    for (;;) {
      let q = build('*').order('id', { ascending: true }).limit(PAGE_CAP);
      if (after !== null) q = q.gt('id', after);
      else if (from !== null) q = q.gte('id', from);
      if (to !== null) q = q.lt('id', to);
      const { data, error } = await q;
      if (error) {
        const e = new Error(error.message);
        e.status = 500;
        throw e;
      }
      const page = data || [];
      rows.push(...page);
      if (page.length < PAGE_CAP) return rows;
      after = page[page.length - 1].id;
    }
  }));
  return parts.flat();
}
