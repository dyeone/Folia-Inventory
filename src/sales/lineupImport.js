import { norm, buildMatchContext, matchSheetRow } from '../purchasing/sheetParsing.js';
import { blockStart, blockEnd } from './lotBlock.js';

// A live's lineup as a sheet: one row per plant — its lineup number (the
// "index" the streamer calls out and the packer finds it by) and its name,
// optionally a listing price and a variety. Every row becomes a NEW plant
// of our own, numbered as the sheet says and staged into the sale.
// Headers are matched loosely; a sheet without one is read as index, name,
// price in that order, and the modal shows what it decided so the operator
// can re-point a column.

export const LINEUP_ALIASES = {
  index: ['index', 'idx', '#', 'no', 'no.', 'num', 'number', 'lot', 'lot number', 'lot #', 'lot no', 'lineup', 'lineup number', 'lineup #', 'live number', 'live #', 'live', 'position', 'seq', 'order'],
  name: ['name', 'plant', 'plant name', 'title', 'item', 'item name', 'species', 'listing', 'listing title', 'description', 'product', 'product name'],
  price: ['price', 'listing price', 'list price', 'start price', 'starting price', 'start', 'usd', '$', 'amount'],
  variety: ['variety', 'genus', 'type', 'category'],
};
export const LINEUP_ROLES = ['index', 'name', 'price', 'variety'];
export const NO_COLS = { index: -1, name: -1, price: -1, variety: -1 };

export function detectLineupColumns(row) {
  const cols = { ...NO_COLS };
  (row || []).forEach((cell, i) => {
    const h = norm(cell);
    if (!h) return;
    for (const role of LINEUP_ROLES) {
      if (cols[role] < 0 && LINEUP_ALIASES[role].includes(h)) { cols[role] = i; return; }
    }
  });
  return cols;
}

const LOT_RE = /^#?\s*(\d{1,6})$/;
export function parseLotCell(raw) {
  const m = LOT_RE.exec(String(raw ?? '').trim());
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// grid: array-of-arrays (readSheetGrid). forcedCols: the operator's own
// column choice from the modal — replaces detection; the first row then
// stays data unless its index cell isn't a number (it reads as a header).
export function parseLineupGrid(grid, forcedCols = null) {
  const nonEmpty = (grid || []).filter(r => (r || []).some(c => norm(c) !== ''));
  if (!nonEmpty.length) return { cols: { ...NO_COLS }, rows: [], header: null, headerless: false };
  let cols, start = 0, header = null, headerless = false;
  if (forcedCols) {
    cols = { ...NO_COLS, ...forcedCols };
    if (parseLotCell(nonEmpty[0][cols.index]) == null) { header = nonEmpty[0]; start = 1; }
  } else {
    const detected = detectLineupColumns(nonEmpty[0]);
    if (detected.index >= 0 && detected.name >= 0) { cols = detected; header = nonEmpty[0]; start = 1; }
    else { cols = { index: 0, name: 1, price: 2, variety: -1 }; headerless = true; }
  }
  const rows = [];
  for (let i = start; i < nonEmpty.length; i++) {
    const r = nonEmpty[i];
    const cell = (c) => (c >= 0 ? String(r[c] ?? '').trim() : '');
    const priceRaw = cell(cols.price).replace(/[$,\s]/g, '');
    const price = priceRaw ? parseFloat(priceRaw) : NaN;
    rows.push({
      line: i + 1,
      index: parseLotCell(cell(cols.index)),
      indexRaw: cell(cols.index),
      name: cell(cols.name).replace(/\s+/g, ' '),
      variety: cell(cols.variety),
      price: Number.isFinite(price) && price >= 0 ? price : null,
    });
  }
  return { cols, rows, header, headerless };
}

// What's wrong with each row. Blocking problems drop the row; a number
// outside the week's block is only a warning (the Number button asks the
// same question). `takenInSale`: lot → plant already numbered in this sale;
// `takenThisWeek`: lot → plant on another sale in the same lot week.
export function checkLineupRows(rows, { week, takenInSale = new Map(), takenThisWeek = new Map() }) {
  const seen = new Map();
  for (const r of rows) if (r.index != null) seen.set(r.index, (seen.get(r.index) || 0) + 1);
  const lo = blockStart(week), hi = blockEnd(week);
  const who = (it) => it?.sku || it?.name || 'a plant';
  return rows.map((r) => {
    const problems = [];
    if (r.index == null) problems.push({ code: 'no-index', text: r.indexRaw ? `"${r.indexRaw}" is not a lineup number` : 'no lineup number' });
    if (!r.name) problems.push({ code: 'no-name', text: 'no name' });
    if (r.index != null) {
      if (seen.get(r.index) > 1) problems.push({ code: 'dup', text: `#${r.index} is on ${seen.get(r.index)} rows of this file` });
      if (takenInSale.has(r.index)) problems.push({ code: 'taken-sale', text: `#${r.index} is already ${who(takenInSale.get(r.index))} in this sale` });
      if (takenThisWeek.has(r.index)) problems.push({ code: 'taken-week', text: `#${r.index} is ${who(takenThisWeek.get(r.index))} on another sale this week` });
      if (r.index < lo || r.index > hi) problems.push({ code: 'block', warn: true, text: `#${r.index} is outside this week's ${lo}–${hi}` });
    }
    return { ...r, problems, blocking: problems.some(p => !p.warn) };
  });
}

// Lot → plant maps for checkLineupRows, from the app's items and sales.
export function takenLots(items, sales, sale, saleWeekOf) {
  const takenInSale = new Map(), takenThisWeek = new Map();
  const week = saleWeekOf(sale);
  const weekOf = new Map((sales || []).map(s => [s.id, saleWeekOf(s)]));
  for (const it of items || []) {
    if (it.deletedAt || !it.saleId) continue;
    const lot = parseLotCell(it.lotNumber);
    if (lot == null) continue;
    if (it.saleId === sale.id) { if (!takenInSale.has(lot)) takenInSale.set(lot, it); }
    else if (weekOf.get(it.saleId) === week && !takenThisWeek.has(lot)) takenThisWeek.set(lot, it);
  }
  return { takenInSale, takenThisWeek };
}

// The variety a row files under: its variety cell when that's a variety we
// have (by name or code), else the first word of the name when THAT is one
// ("Anthurium crystallinum"), else the modal's default.
export function varietyForRow(row, varieties, defaultVarietyId) {
  const list = varieties || [];
  const byName = new Map(list.map(v => [norm(v.name), v]));
  const byCode = new Map(list.map(v => [norm(v.code), v]));
  if (row.variety) {
    const v = byName.get(norm(row.variety)) || byCode.get(norm(row.variety));
    if (v) return v;
  }
  const first = norm(row.name).split(/[\s·,(/-]+/)[0];
  if (first && byName.has(first)) return byName.get(first);
  return list.find(v => v.id === defaultVarietyId) || null;
}

// Rows that passed → the item payloads the intake handler saves (same shape
// as SellerIntakeModal's own-plants mode, plus the lineup number). A name
// that is a species we have ("crystallinum", or "Anthurium crystallinum"
// with the variety word in front) links to it, so its list price and sell
// note follow the plant; the name itself stays as the sheet wrote it.
export function lineupPayloads(checked, { sale, varieties, species, defaultVarietyId }) {
  const ctx = buildMatchContext(species || [], varieties || []);
  const out = [];
  for (const r of checked) {
    if (r.blocking) continue;
    const v = varietyForRow(r, varieties, defaultVarietyId);
    if (!v) continue;
    const bare = norm(r.name).startsWith(`${norm(v.name)} `) ? r.name.slice(v.name.length).trim() : null;
    let speciesId = null;
    for (const candidate of [r.name, bare].filter(Boolean)) {
      const m = matchSheetRow({ species: candidate, variety: v.name }, ctx, v.id);
      if (m.status === 'matched') { speciesId = m.speciesId; break; }
    }
    out.push({
      type: 'plant',
      variety: v.name,
      name: r.name,
      speciesId,
      listingPrice: r.price,
      saleId: sale.id,
      lotKind: 'sale',
      lotNumber: String(r.index),
      status: 'available',
      quantity: 1,
      grossCost: null, cost: null, netCost: null,
    });
  }
  return out;
}
