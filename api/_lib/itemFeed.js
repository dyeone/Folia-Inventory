// The plant list's change feed (migration 0056): what changed since a poll's
// last read, instead of the whole list.
//
// Every open Shipping tab and packer device re-read every plant of the brand
// every 8 s (~7,000 rows / ~9 MB, ~18 queries). On the Nano database that
// ran the disk-read budget dry and the database stopped answering. Now a
// poll sends the `syncAt` its last read returned and gets back the rows the
// database stamped since (changedAt, set by a trigger on every insert and
// update — no write path can forget it) plus the ids that left the list
// (tombstones: deleted for good, or moved to the other brand).
//
// The window starts OVERLAP_MS before `since`: syncAt is this server's clock
// taken before the read, changedAt the database's, and a write can be
// stamped a moment before it commits. Rows re-sent from the overlap merge by
// id, so a repeat is harmless.
import { supabase } from './supabase.js';
import { fetchAllById } from './fetchAll.js';

export const OVERLAP_MS = 2 * 60 * 1000;
// A client away longer than this reloads everything (and tombstones only
// need to outlive it — the full read purges ones older than a day).
export const MAX_FEED_AGE_MS = 30 * 60 * 1000;
const TOMBSTONE_KEEP_MS = 24 * 60 * 60 * 1000;
const PAGE_CAP = 1000;

// `since` from the query string → ms, or null when the poll should read
// everything (missing, malformed, too old, or from the future).
export function feedSince(raw, now = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  if (now - ms > MAX_FEED_AGE_MS || ms - now > 5 * 60 * 1000) return null;
  return ms;
}

// Before 0056 is applied the column / table don't exist: read everything.
function isMissingFeed(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /changedAt|inventory_item_tombstones/.test(text)
    && /42703|42P01|PGRST20[0-9]|does not exist|schema cache|Could not find/i.test(text);
}

// → { items, removedIds }, or null when the full read must answer instead
// (feed not migrated yet, or more tombstones than one page).
export async function readItemFeed(brandId, sinceMs) {
  const from = new Date(sinceMs - OVERLAP_MS).toISOString();
  const { data: gone, error: goneErr } = await supabase
    .from('inventory_item_tombstones')
    .select('itemId')
    .eq('brandId', brandId)
    .gte('goneAt', from)
    .limit(PAGE_CAP);
  if (goneErr) {
    if (isMissingFeed(goneErr)) return null;
    const e = new Error(goneErr.message); e.status = 500; throw e;
  }
  if ((gone || []).length >= PAGE_CAP) return null;
  let items;
  try {
    items = await fetchAllById(() => supabase
      .from('inventory_items')
      .select('*')
      .eq('brandId', brandId)
      .gte('changedAt', from));
  } catch (e) {
    if (isMissingFeed(e)) return null;
    throw e;
  }
  return { items, removedIds: [...new Set((gone || []).map((g) => g.itemId))] };
}

// Housekeeping that rides the full read (app load, the clients' periodic
// full refresh) — never the 8 s feed polls. Best-effort: a read never fails
// on it.
export async function itemHousekeeping(brandId, now = Date.now()) {
  try {
    // Trash older than 30 days is deleted for good. The not-null guard is
    // defense in depth — `lt` already excludes NULL by SQL semantics, but
    // one ORM quirk would silently nuke production data.
    await supabase
      .from('inventory_items')
      .delete()
      .eq('brandId', brandId)
      .not('deletedAt', 'is', null)
      .lt('deletedAt', new Date(now - 30 * 86400 * 1000).toISOString());
    // (Errors before 0056 — no such table — are ignored like any other.)
    await supabase
      .from('inventory_item_tombstones')
      .delete()
      .eq('brandId', brandId)
      .lt('goneAt', new Date(now - TOMBSTONE_KEEP_MS).toISOString());
  } catch { /* best-effort */ }
}
