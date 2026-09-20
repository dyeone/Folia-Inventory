// Vendor invoice PDF → order rows for the wholesale Import list.
//
// Brighten's "Proforma Invoice" is an Excel-generated PDF with a real text
// layer: one text item per cell — NO.xx group, item name (even when Excel
// wrapped it visually), unit price, quantity, amount — all on one baseline
// per row, followed by a "shipping and tax cost" row and a "Total" row.
// pdf.js hands us each item with its x/y, so a row is simply the text
// items sharing a baseline, classified by column: the "$" tokens are price
// and amount, the integer between them is the quantity, the rest is the
// name. No OCR, no layout guessing. The text items come from the server
// (api/purchase-orders.js pdf-text — pdf.js 6 needs a newer Safari than
// the desk has); this module is pure and runs the same in Node tests.
//
// The parsed lines are turned into the same grid shape a supplier
// spreadsheet produces (header Item / Quantity / Price) so the rest of the
// import pipeline — column detection, catalog matching, duplicate folding,
// the review UI — runs unchanged. The invoice's own numbers (shipping,
// totals, invoice no/date, vendor) ride along as `meta` for prefilling
// and a sum check.

const MONEY_RE = /^\$\s?-?[\d,]+(?:\.\d{1,2})?$/;
const INT_RE = /^\d{1,6}$/;
const GROUP_RE = /^NO\.?\s*\d+$/i;
// Trailing form words the vendor appends to the plant name ("… plug",
// "… pot"). Stripped for catalog matching (our species names carry no
// form) and kept on the row as `form`.
const FORM_RE = /\s+(plugs?|pots?|cuttings?)\s*$/i;

const money = (s) => parseFloat(String(s).replace(/[$,\s]/g, ''));

// Text items → lines (same baseline, ±2.5pt), each line's items sorted by x.
function toLines(items) {
  const lines = [];
  for (const it of items) {
    const s = String(it.str || '').trim();
    if (!s) continue;
    let line = lines.find((l) => Math.abs(l.y - it.y) <= 2.5);
    if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
    line.items.push({ x: it.x, s });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y); // top of page first
}

// Glue a lone "$" onto the number that follows it (some exporters split
// the currency sign into its own text run).
function mergeCurrency(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.s === '$' && tokens[i + 1] && /^[\d,]+(?:\.\d{1,2})?$/.test(tokens[i + 1].s)) {
      out.push({ x: t.x, s: `$${tokens[i + 1].s}` });
      i++;
    } else out.push(t);
  }
  return out;
}

// pages: [{ items: [{ str, x, y }] }] in page order. Pure — no pdf.js here.
export function parseInvoicePages(pages) {
  const rows = [];
  const warnings = [];
  let shippingFee = null;
  // The vendor's "Total" quantity counts fee lines too (shipping shows as
  // qty 1), so the sum check adds them back before comparing.
  let feeQty = 0;
  let totalQty = null;
  let totalAmount = null;
  let supplier = '';
  let invoiceNo = '';
  let invoiceDate = '';
  let lineNo = 0;

  pages.forEach((page, pi) => {
    const lines = toLines(page.items);
    if (pi === 0) {
      // Vendor = the first text line of page 1; invoice no/date by label.
      supplier = lines[0]?.items.map((t) => t.s).join(' ').trim() || '';
      for (const l of lines) {
        const text = l.items.map((t) => t.s).join(' ');
        const no = text.match(/INVOICE\s*NO\.?\s*[:：]\s*([A-Z0-9-]+)/i);
        if (no && !invoiceNo) invoiceNo = no[1];
        const dt = text.match(/INVOICE\s*DATE\s*[:：]\s*(.+)$/i);
        if (dt && !invoiceDate) invoiceDate = dt[1].trim();
      }
    }
    for (const l of lines) {
      const tokens = mergeCurrency(l.items);
      const moneyIdx = tokens.map((t, i) => (MONEY_RE.test(t.s) ? i : -1)).filter((i) => i >= 0);
      const text = tokens.map((t) => t.s).join(' ');
      if (/^total\b/i.test(text.trim())) {
        // "Total  1630  $31,360.85" — qty then amount.
        const ints = tokens.filter((t) => INT_RE.test(t.s.replace(/,/g, '')));
        const amts = tokens.filter((t) => MONEY_RE.test(t.s));
        if (ints.length) totalQty = parseInt(ints[ints.length - 1].s.replace(/,/g, ''), 10);
        if (amts.length) totalAmount = money(amts[amts.length - 1].s);
        continue;
      }
      if (moneyIdx.length < 2) continue; // headers, addresses, bank details
      const priceI = moneyIdx[0];
      const amountI = moneyIdx[moneyIdx.length - 1];
      const between = tokens.slice(priceI + 1, amountI).filter((t) => INT_RE.test(t.s));
      const qty = between.length ? parseInt(between[between.length - 1].s, 10) : NaN;
      const price = money(tokens[priceI].s);
      const amount = money(tokens[amountI].s);
      const nameTokens = tokens.slice(0, priceI).filter((t) => !GROUP_RE.test(t.s));
      const groupTok = tokens.slice(0, priceI).find((t) => GROUP_RE.test(t.s));
      const rawName = nameTokens.map((t) => t.s).join(' ').replace(/\s+/g, ' ').trim();
      if (!rawName) { warnings.push(`Page ${pi + 1}: a priced line with no name was skipped (${text.slice(0, 60)})`); continue; }
      if (/shipping|freight|tax/i.test(rawName) && !/^(alocasia|anthurium|philodendron|monstera|begonia)/i.test(rawName)) {
        shippingFee = (shippingFee || 0) + (Number.isFinite(amount) ? amount : 0);
        if (Number.isFinite(qty)) feeQty += qty;
        continue;
      }
      if (!Number.isFinite(qty)) { warnings.push(`"${rawName}": no quantity between price and amount — row skipped`); continue; }
      const formMatch = rawName.match(FORM_RE);
      const name = rawName.replace(FORM_RE, '').trim();
      lineNo++;
      const row = {
        line: lineNo,
        group: groupTok ? groupTok.s.toUpperCase().replace(/\s+/g, '') : '',
        name,
        form: formMatch ? formMatch[1].toLowerCase().replace(/s$/, '') : '',
        price: Number.isFinite(price) ? price : null,
        qty,
        amount: Number.isFinite(amount) ? amount : null,
      };
      if (row.price != null && row.amount != null && Math.abs(row.price * row.qty - row.amount) > 0.05) {
        warnings.push(`"${rawName}": ${qty} × $${row.price.toFixed(2)} ≠ $${row.amount.toFixed(2)} on the invoice — check the quantity`);
      }
      rows.push(row);
    }
  });

  const sumQty = rows.reduce((n, r) => n + r.qty, 0);
  const sumAmount = rows.reduce((n, r) => n + (r.amount || 0), 0) + (shippingFee || 0);
  if (totalQty != null && sumQty + feeQty !== totalQty) warnings.push(`Rows add up to ${sumQty} pcs but the invoice total says ${totalQty - feeQty} — a line may have been missed`);
  if (totalAmount != null && Math.abs(sumAmount - totalAmount) > 0.05) warnings.push(`Rows add up to $${sumAmount.toFixed(2)} but the invoice total says $${totalAmount.toFixed(2)}`);

  return { rows, shippingFee, totalQty, totalAmount, sumQty, sumAmount, supplier, invoiceNo, invoiceDate, warnings };
}

// Parsed invoice → the spreadsheet-shaped grid the import pipeline reads
// (Item / Quantity / Price header, then one row per invoice line).
export function invoiceToGrid(parsed) {
  return [
    ['Item', 'Quantity', 'Price'],
    ...parsed.rows.map((r) => [r.name, String(r.qty), r.price != null ? r.price.toFixed(2) : '']),
  ];
}

// Message for an invoice that parsed to nothing, or null when rows exist.
export function invoiceRowsError(parsed, pages) {
  if (parsed.rows.length > 0) return null;
  const hasText = (pages || []).some((p) => (p.items || []).some((it) => String(it.str || '').trim()));
  return hasText
    ? 'No priced item lines found in that PDF — is it the vendor invoice (item · price · qty · amount)?'
    : 'That PDF has no text layer (a scan). Export the invoice from Excel/PDF, or upload the .xlsx instead.';
}
