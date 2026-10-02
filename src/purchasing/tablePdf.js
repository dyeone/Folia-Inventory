// Generic table PDF (a vendor PACKING LIST, a price list) → order rows.
//
// The Brighten invoice parser (invoicePdf.js) reads a specific layout: one
// baseline per row with price and amount on it. Packing lists don't hold
// that shape — the one that prompted this ("Detailed Packinglist", Excel →
// PDF) centres a wrapped plant name ABOVE and BELOW the numbers, and sets
// the unit price on its own baseline 3pt under the row. Reading it by
// baseline yields nothing.
//
// So this reads the page as a TABLE: find the header line (two or more
// known column names on one baseline, with wrapped header words such as
// "Packing" / "QTY" on the lines next to it folded in), turn the header
// cells into column bands across the page, drop every text item into the
// band its centre falls in, and cut the page into rows wherever the
// vertical gap between text is bigger than a line. A row's cell is its
// fragments joined top to bottom. Columns are then mapped to roles by
// header name (description → plant, packing qty → quantity, price,
// amount, carton), the same alias idea as sheetParsing.detectColumns.
//
// When the header can't be recognised — no header line at all, or none of
// its names means "plant" — nothing is guessed: the table comes back with
// `needsMapping` and the columns as the page shows them, and the modal asks
// the operator which column is which (ColumnMapper). The same text items
// come from the server's pdf-text action (see sheetParsing.readInvoicePdf);
// this module is pure and runs the same in Node tests.

import { norm, HEADER_ALIASES } from './sheetParsing.js';

const LINE_TOL = 2.5;            // same baseline (pt)
const ROW_GAP = 10;              // a vertical gap bigger than this starts a new row (pt)
const HEADER_WRAP = 12;          // header words this close above/below the header line belong to it (pt)
const EST_CHAR_W = 5;            // width guess for text items the server sent without one

// Header names → roles. Lowercased, punctuation-light (see headerKey).
// First role whose alias list has the name wins; `qty` is checked before
// `invoiceQty` so a plain "QTY" is the quantity and only an explicit
// "Invoice QTY" lands in the secondary slot.
export const TABLE_ALIASES = {
  species: [...HEADER_ALIASES.species, 'description', 'item description', 'product', 'product name', 'desc',
    'plant description', 'botanical name', 'variety name', 'item name', 'goods', 'commodity', '货品', '貨品', '产品', '產品', '描述'],
  variety: HEADER_ALIASES.variety,
  qty: ['packing qty', 'packing quantity', 'packed qty', 'ship qty', 'shipped qty', 'shipping qty', 'pack qty',
    ...HEADER_ALIASES.qty, 'pcs', 'pieces', 'quantity (pcs)', 'qty (pcs)', '件数', '件數'],
  invoiceQty: ['invoice qty', 'invoice quantity', 'ordered qty', 'order qty', 'ordered', 'inv qty'],
  price: [...HEADER_ALIASES.price, 'unit price', 'price (usd)', 'unit price (usd)', 'usd', 'price usd', 'unit', 'rate'],
  amount: ['amount', 'total', 'line total', 'subtotal', 'total amount', 'amount (usd)', 'total price', 'ext price', 'extended',
    '金额', '金額', '总价', '總價', '小计', '小計'],
  carton: ['carton', 'carton no', 'carton number', 'carton #', 'ctn', 'ctn no', 'box', 'box no', 'box number', 'box #',
    'case', 'case no', '箱号', '箱號', '箱'],
};

export const headerKey = (s) => norm(s).replace(/[.:#()\-_/]+/g, ' ').replace(/\s+/g, ' ').trim();

export function roleForHeader(text) {
  const k = headerKey(text);
  if (!k) return null;
  for (const [role, aliases] of Object.entries(TABLE_ALIASES)) {
    if (aliases.some((a) => headerKey(a) === k)) return role;
  }
  return null;
}

const MONEY_RE = /^-?\$?\s?-?[\d,]+(?:\.\d{1,4})?$/;
const INT_RE = /^[\d,]{1,7}$/;
const money = (s) => { const n = parseFloat(String(s ?? '').replace(/[$¥￥,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const int = (s) => { const t = String(s ?? '').replace(/[,\s]/g, ''); return /^\d+$/.test(t) ? parseInt(t, 10) : null; };

// Items → baselines (±LINE_TOL), top of page first, items left to right.
function toLines(items) {
  const lines = [];
  for (const it of items) {
    const s = String(it.str || '').trim();
    if (!s) continue;
    let line = lines.find((l) => Math.abs(l.y - it.y) <= LINE_TOL);
    if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
    line.items.push(withSpan({ ...it, str: s }));
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y);
}

function withSpan(it) {
  const w = Number.isFinite(it.w) && it.w > 0 ? it.w : it.str.length * EST_CHAR_W;
  return { ...it, w, left: it.x, right: it.x + w, cx: it.x + w / 2 };
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right;

// The header line: the first baseline carrying two or more known column
// names. Wrapped header words on the neighbouring baselines are folded in:
// one that overlaps a header cell extends that cell's name ("Packing" +
// "QTY"), one that sits in a gap becomes a column of its own.
function findHeader(lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const known = l.items.filter((it) => roleForHeader(it.str)).length;
    if (known < 2) continue;
    const cells = l.items.map((it) => ({ left: it.left, right: it.right, parts: [{ y: it.y, x: it.x, s: it.str }] }));
    for (const other of lines) {
      if (other === l || Math.abs(other.y - l.y) > HEADER_WRAP) continue;
      for (const it of other.items) {
        const hit = cells.find((c) => overlaps(c, it));
        if (hit) {
          hit.parts.push({ y: it.y, x: it.x, s: it.str });
          hit.left = Math.min(hit.left, it.left); hit.right = Math.max(hit.right, it.right);
        } else {
          cells.push({ left: it.left, right: it.right, parts: [{ y: it.y, x: it.x, s: it.str }] });
        }
      }
    }
    cells.sort((a, b) => a.left - b.left);
    const columns = cells.map((c) => ({
      left: c.left, right: c.right,
      label: c.parts.sort((p, q) => q.y - p.y || p.x - q.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim(),
    }));
    return { y: l.y, yTop: l.y + HEADER_WRAP, yBottom: l.y - HEADER_WRAP, columns };
  }
  return null;
}

// Column bands: each header cell owns the page from the midpoint to its
// left neighbour to the midpoint to its right one.
function bandsFor(columns) {
  return columns.map((c, i) => ({
    ...c,
    from: i === 0 ? -Infinity : (columns[i - 1].right + c.left) / 2,
    to: i === columns.length - 1 ? Infinity : (c.right + columns[i + 1].left) / 2,
  }));
}

// No header: columns from where the text itself sits. Item centres are
// clustered left to right; a jump wider than a few characters starts a new
// column. Rough, but enough for the operator to point at "that one is the
// plant name".
function bandsFromItems(items) {
  const xs = [...items].sort((a, b) => a.cx - b.cx);
  const groups = [];
  for (const it of xs) {
    const g = groups[groups.length - 1];
    if (g && it.left <= g.right + 18) { g.right = Math.max(g.right, it.right); g.left = Math.min(g.left, it.left); g.n++; }
    else groups.push({ left: it.left, right: it.right, n: 1 });
  }
  return bandsFor(groups.map((g, i) => ({ left: g.left, right: g.right, label: `Column ${String.fromCharCode(65 + (i % 26))}` })));
}

// Items (below the header) → rows: sort by y, cut at vertical gaps wider
// than a line, then group each row's fragments by band.
function rowsFrom(items, bands) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let cur = null;
  for (const it of sorted) {
    if (!cur || cur.lastY - it.y > ROW_GAP) { cur = { yTop: it.y, lastY: it.y, cells: bands.map(() => []) }; rows.push(cur); }
    cur.lastY = Math.min(cur.lastY, it.y);
    const bi = bands.findIndex((b) => it.cx >= b.from && it.cx < b.to);
    if (bi >= 0) cur.cells[bi].push(it);
  }
  return rows.map((r) => ({
    y: r.yTop,
    cells: r.cells.map((frags) => frags.sort((a, b) => b.y - a.y || a.x - b.x).map((f) => f.str).join(' ').replace(/\s+/g, ' ').trim()),
  }));
}

// pages: [{ items: [{ str, x, y, w? }] }] → table. Pure.
//   recognised: { columns, roles, rows, lines, warnings, sums… }
//   not:        { needsMapping: true, columns, rows, hasText }
export function parseTablePages(pages) {
  const warnings = [];
  let header = null;
  let bands = null;
  const allRows = [];
  const hasText = (pages || []).some((p) => (p.items || []).some((it) => String(it.str || '').trim()));

  (pages || []).forEach((page, pi) => {
    const lines = toLines(page.items || []);
    const h = findHeader(lines);
    if (h && !header) { header = h; bands = bandsFor(h.columns); }
    let body = lines;
    if (h) body = lines.filter((l) => l.y < h.yBottom);          // this page's header + title lines above it
    else if (!header) return;                                    // nothing recognised yet: a cover page
    const items = body.flatMap((l) => l.items);
    const rows = rowsFrom(items, bands || (bands = bandsFromItems(items)));
    for (const r of rows) allRows.push({ ...r, page: pi + 1 });
  });

  if (!header) {
    // Headerless: columns from where the text sits across all pages, rows
    // cut page by page (y restarts on every page).
    const perPage = (pages || []).map((p) => toLines(p.items || []).flatMap((l) => l.items));
    const items = perPage.flat();
    if (!items.length) return { needsMapping: true, hasText, columns: [], rows: [] };
    const b = bandsFromItems(items);
    const rows = perPage.flatMap((pageItems) => rowsFrom(pageItems, b).map((r) => r.cells));
    return { needsMapping: true, hasText, columns: b.map((c) => c.label), rows };
  }

  const roles = {};
  header.columns.forEach((c, i) => {
    const role = roleForHeader(c.label);
    if (role && roles[role] === undefined) roles[role] = i;
  });
  if (roles.qty === undefined && roles.invoiceQty !== undefined) { roles.qty = roles.invoiceQty; delete roles.invoiceQty; }
  if (roles.species === undefined) {
    return { needsMapping: true, hasText, columns: header.columns.map((c) => c.label), roles, rows: allRows.map((r) => r.cells) };
  }
  return { ...shapeRows(allRows, roles, warnings), columns: header.columns.map((c) => c.label), roles, needsMapping: false, hasText };
}

// Rows of cells + a role map → order lines with the checks a packing list
// allows (price × qty = amount, packed vs invoiced, totals line). Shared by
// the recognised path and the operator-mapped one.
export function shapeRows(rows, roles, warnings = []) {
  const lines = [];
  let totalQty = null;
  let totalAmount = null;
  let lineNo = 0;
  for (const r of rows) {
    const cells = Array.isArray(r) ? r : r.cells;
    const cell = (role) => (roles[role] === undefined ? '' : (cells[roles[role]] ?? ''));
    const name = cell('species').replace(/\s+/g, ' ').trim();
    const joined = cells.join(' ').trim();
    if (/^(grand\s+)?total\b/i.test(joined) || (!name && /\btotal\b/i.test(joined))) {
      const q = int(cell('qty')); const a = money(cell('amount'));
      if (q != null) totalQty = q;
      if (a != null) totalAmount = a;
      continue;
    }
    if (!name) continue;
    if (name.length > 200 || (!INT_RE.test(cell('qty').replace(/\s/g, '')) && roles.qty !== undefined && cell('qty') === '')) {
      // a stray fragment row (a note under the table) without numbers
      if (cell('qty') === '' && cell('price') === '') continue;
    }
    const qty = int(cell('qty'));
    const invoiceQty = int(cell('invoiceQty'));
    const price = money(cell('price'));
    const amount = money(cell('amount'));
    lineNo++;
    const line = {
      line: lineNo,
      name,
      variety: cell('variety').trim(),
      carton: cell('carton').replace(/\s+/g, '').toUpperCase(),
      qty: qty ?? invoiceQty ?? null,
      invoiceQty,
      price,
      amount,
    };
    if (line.qty == null) warnings.push(`"${name}": no quantity on that line — check it before importing`);
    if (qty != null && invoiceQty != null && qty !== invoiceQty) {
      warnings.push(`"${name}": ${qty} packed but ${invoiceQty} invoiced — the packed count is used`);
    }
    if (line.price != null && line.qty != null && line.amount != null && Math.abs(line.price * line.qty - line.amount) > 0.05) {
      // price × invoiced = amount is normal on a packing list; only flag when neither count explains the amount
      const byInvoice = invoiceQty != null && Math.abs(line.price * invoiceQty - line.amount) <= 0.05;
      if (!byInvoice) warnings.push(`"${name}": ${line.qty} × $${line.price.toFixed(2)} ≠ $${line.amount.toFixed(2)} on the list — check the quantity`);
    }
    lines.push(line);
  }
  const sumQty = lines.reduce((n, l) => n + (l.qty || 0), 0);
  const sumAmount = lines.reduce((n, l) => n + (l.amount || 0), 0);
  if (totalQty != null && sumQty !== totalQty) warnings.push(`Rows add up to ${sumQty} pcs but the list's total says ${totalQty} — a line may have been missed`);
  if (totalAmount != null && Math.abs(sumAmount - totalAmount) > 0.05) warnings.push(`Rows add up to $${sumAmount.toFixed(2)} but the list's total says $${totalAmount.toFixed(2)}`);
  const cartons = new Set(lines.map((l) => l.carton).filter(Boolean));
  return { rows: lines, warnings, sumQty, sumAmount, totalQty, totalAmount, cartons: cartons.size };
}

// Parsed table → the spreadsheet-shaped grid the import pipeline reads.
export function tableToGrid(parsed) {
  const hasVariety = parsed.rows.some((r) => r.variety);
  return [
    ['Item', 'Quantity', 'Price', ...(hasVariety ? ['Genus'] : [])],
    ...parsed.rows.map((r) => [
      r.name,
      r.qty != null ? String(r.qty) : '',
      r.price != null ? r.price.toFixed(2) : '',
      ...(hasVariety ? [r.variety] : []),
    ]),
  ];
}
