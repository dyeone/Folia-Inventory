// Shared supplier-spreadsheet plumbing for ImportOrderModal (wholesale
// order import) and VendorPriceModal (price-list update): the charset-safe
// CSV decoding, the loose header detection with Chinese aliases, and the
// common size rails. One home so the two flows can't drift.

export const norm = (s) => String(s ?? '').trim().toLowerCase();

// Note: no '#' or 'amount' as qty aliases — '#' is usually the row-number
// column and 'amount' is usually a dollar total; binding either to qty
// silently orders row-47 or $249 worth of plants. Chinese aliases cover the
// headers wholesale suppliers actually send (simplified + traditional).
// 品种/品種 bind to SPECIES, not variety: Chinese nursery sheets use it for
// the cultivar/plant-name column; the genus column is 属/屬. detectColumns
// is first-alias-wins, so a sheet with both 品名 and 品种 keeps 品名 as the
// name column.
export const HEADER_ALIASES = {
  species: ['species', 'name', 'plant', 'plant name', 'species name', 'cultivar', 'item',
    '品名', '名称', '名稱', '植物', '品种', '品種', '品种名', '品種名'],
  variety: ['variety', 'genus', '属', '屬'],
  qty: ['qty', 'quantity', 'count', 'units', '数量', '數量', '株数', '株數'],
  price: ['price', 'cost', 'wholesale', 'unit price', 'wholesale price', 'unit cost', 'unit wholesale price',
    'new price', '单价', '單價', '价格', '價格', '批发价', '批發價', '新价', '新價'],
};

// Sanity rails on supplier-sheet cells. Rows outside them are skipped with
// a visible chip rather than silently coerced — a date serial in the qty
// column must not become a million-unit order.
// MAX_ROWS mirrors IMPORT_LINES_MAX in api/purchase-orders.js.
export const MAX_ROWS = 500;
export const MAX_QTY = 10000;
export const MAX_NAME_LEN = 200;
// Above this many to-be-created species, the upload modals demand an extra
// confirm — that volume usually means a wrong column was read as the name.
export const MASS_CREATE_WARN = 50;

export function detectColumns(headerRow) {
  const cols = {};
  headerRow.forEach((cell, idx) => {
    const h = norm(cell);
    if (!h) return;
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (cols[key] === undefined && aliases.includes(h)) cols[key] = idx;
    }
  });
  return cols;
}

// CSV bytes → string with real charset detection. SheetJS's browser build
// reads un-BOM'd CSV bytes as Latin-1, which turns UTF-8 Chinese into
// mojibake (红掌 → "çº¢æŽŒ") before any matching ever runs — and Chinese
// Excel routinely saves "CSV" in the system codepage (GB18030 / Big5),
// which Latin-1 garbles the same way. BOM wins when present; else the
// first STRICT decoder that accepts the bytes wins (UTF-8's structure
// makes false positives rare; GB18030 is tried before Big5 because
// mainland suppliers are the common case — a Big5 file misread as GB18030
// shows visibly wrong Chinese in the preview, the gate before any write).
// Latin-1 never rejects anything, so it's the explicit last resort.
export function decodeCsvBytes(bytes) {
  try {
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  } catch { /* fall through to the strict cascade */ }
  for (const enc of ['utf-8', 'gb18030', 'big5']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch { /* not this encoding */ }
  }
  return new TextDecoder('windows-1252').decode(bytes);
}

// File → non-empty grid rows (array-of-arrays). CSVs go through our own
// charset detection; xlsx/xls carry their encoding internally and stay on
// the array path. xlsx itself is lazy-loaded (~140KB gzip).
export async function readSheetGrid(file) {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const isCsv = /\.(csv|txt)$/i.test(file.name || '') || /csv/i.test(file.type || '');
  const wb = isCsv
    ? XLSX.read(decodeCsvBytes(new Uint8Array(buf)), { type: 'string' })
    : XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  return grid.filter(r => r.some(c => norm(c) !== ''));
}

// Grid guards + header/column decision, shared by every sheet-upload flow
// (orders AND the vendor price list). The row cap counts DATA rows after the
// header decision — a headerless sheet must not get a free 501st row past
// the server's hard 500 cap. Throws user-facing messages the modals surface
// as the parse error.
export function splitGrid(nonEmpty, headerlessCols) {
  if (!nonEmpty.length) throw new Error('The file looks empty.');
  let cols = detectColumns(nonEmpty[0]);
  let dataRows;
  if (cols.species !== undefined) {
    dataRows = nonEmpty.slice(1);
  } else {
    cols = headerlessCols;
    dataRows = nonEmpty;
  }
  if (dataRows.length > MAX_ROWS) {
    throw new Error(`That's ${dataRows.length} data rows — the cap is ${MAX_ROWS}. Split the sheet.`);
  }
  return { cols, dataRows };
}

// Grid rows → order rows {row, species, variety, qty, price[, status]}.
// Shared by the import and update-order modals so a supplier sheet parses
// identically whichever door it comes in.
export function parseOrderRows(nonEmpty) {
  // Headerless: species, qty, price — in that order.
  const { cols, dataRows } = splitGrid(nonEmpty, { species: 0, qty: 1, price: 2 });

  const rows = dataRows
    .map((r, i) => {
      const speciesName = String(r[cols.species] ?? '').trim();
      if (!speciesName) return null;
      // Commas stripped like the price column — "1,000" must not
      // parseInt to 1. An explicit 0 (out-of-stock marker) or an
      // absurd value is skipped visibly, never coerced.
      const qtyRaw = cols.qty !== undefined ? String(r[cols.qty] ?? '').replace(/[,\s]/g, '') : '';
      const qty = cols.qty === undefined || qtyRaw === '' ? 1 : parseInt(qtyRaw, 10);
      // ¥/￥ stripped alongside $ — Chinese vendor sheets (批发价/單價) carry
      // them, and an unstripped symbol would NaN → null → silently fall back
      // to the catalog price instead of using the sheet's.
      const priceRaw = cols.price !== undefined ? String(r[cols.price] ?? '').replace(/[$¥￥,\s]/g, '') : '';
      const price = priceRaw === '' ? null : parseFloat(priceRaw);
      const row = {
        row: i + 1,
        species: speciesName,
        variety: cols.variety !== undefined ? String(r[cols.variety] ?? '').trim() : '',
        qty: Number.isFinite(qty) ? qty : 0,
        price: Number.isFinite(price) && price >= 0 ? price : null,
      };
      if (row.qty < 1 || row.qty > MAX_QTY) return { ...row, status: 'bad-qty' };
      if (speciesName.length > MAX_NAME_LEN) return { ...row, status: 'bad-name' };
      return row;
    })
    .filter(Boolean);

  if (!rows.length) throw new Error('No usable rows found — is there a species/name column?');
  // A sheet with headers but no recognizable qty column silently defaults
  // every row to 1 plant — the modals make that loud, not silent.
  return { rows, noQtyColumn: cols.qty === undefined };
}

// Catalog lookups the row matcher needs, built once per species/varieties
// change: epithet (lowercased) → [species…] (a name can exist in several
// varieties, so the variety column disambiguates), plus variety maps.
export function buildMatchContext(species, varieties) {
  const speciesIndex = new Map();
  for (const s of species || []) {
    const k = norm(s.epithet);
    if (!speciesIndex.has(k)) speciesIndex.set(k, []);
    speciesIndex.get(k).push(s);
  }
  return {
    speciesIndex,
    varietyByName: new Map((varieties || []).map(v => [norm(v.name), v])),
    varietyById: new Map((varieties || []).map(v => [v.id, v])),
  };
}

// One parsed row → match outcome against the catalog. defVarId is where a
// new species lands when the sheet has no (or an unknown-to-us) variety cell.
export function matchSheetRow(r, { speciesIndex, varietyByName }, defVarId) {
  const candidates = speciesIndex.get(norm(r.species)) || [];
  const wantVariety = r.variety ? varietyByName.get(norm(r.variety)) : null;
  // An unrecognized variety cell (size grades, 'TC', supplier codes)
  // degrades to name-only matching — a unique catalog match still wins.
  let narrowed = wantVariety
    ? candidates.filter(s => s.varietyId === wantVariety.id)
    : candidates;
  // A name that exists in several varieties without a usable variety
  // cell: prefer the chosen default genus before calling it ambiguous.
  if (!wantVariety && narrowed.length > 1) {
    const inDefault = narrowed.filter(s => s.varietyId === defVarId);
    if (inDefault.length === 1) narrowed = inDefault;
  }
  if (narrowed.length === 1) return { status: 'matched', speciesId: narrowed[0].id, varietyId: narrowed[0].varietyId };
  if (narrowed.length > 1) return { status: 'ambiguous' };
  // No match anywhere → create: under the sheet's variety when given.
  // A row explicitly naming a genus we DON'T have is skipped — filing it
  // under the default would mislabel it (add the variety, re-upload).
  if (wantVariety) return { status: 'create', varietyId: wantVariety.id };
  if (r.variety) return { status: 'unknown-variety' };
  if (defVarId) return { status: 'create', varietyId: defVarId, viaDefault: true };
  return { status: 'unmatched' };
}

// Fold duplicate sheet rows (same matched species, or same to-be-created
// name under the same variety) into the FIRST occurrence: quantities sum,
// the first explicit price wins, later rows become 'duplicate' chips.
// Mutates the passed rows. A merged total past MAX_QTY marks the whole
// species bad — the server enforces the same cap on the aggregate.
export function mergeDuplicateRows(rows) {
  const firstByKey = new Map();
  for (const r of rows) {
    if (r.status !== 'matched' && r.status !== 'create') continue;
    const key = r.status === 'matched' ? `m:${r.speciesId}` : `c:${r.varietyId}:${norm(r.species)}`;
    const first = firstByKey.get(key);
    if (!first) { firstByKey.set(key, r); continue; }
    first.qty += r.qty;
    r.status = 'duplicate';
    r.priceConflict = r.price != null && first.price != null && r.price !== first.price;
    if (first.price == null && r.price != null) first.price = r.price;
  }
  for (const first of firstByKey.values()) {
    if (first.qty > MAX_QTY) first.status = 'bad-qty';
  }
  return rows;
}
