// TikTok Seller Center bulk-listing export for TC lives.
//
// The vendored template (public/tiktok-flowers-template.xlsx) is TikTok's
// own generated workbook for Garden Supplies/Live Plants/Indoor Plants/
// Flowers — Seller Center's bulk upload validates against its hidden
// config sheets (template id/version live in TemplateConfig), so the
// export FILLS that exact file instead of fabricating a lookalike: the
// header rows stay untouched, data rows land from Excel row 7 down, and
// every other sheet rides along verbatim. A plain-CSV twin (same columns,
// UTF-8 BOM so Chinese names survive Excel) is offered alongside.
//
// TC plantlets of one species are interchangeable, so the export groups
// the sale's TC items per species: one listing row with quantity = the
// group's count and Seller SKU = the group's first inventory SKU (the
// stable handle back into our system when TikTok orders reference it).

const CATEGORY = 'Garden Supplies/Live Plants/Indoor Plants/Flowers';
const TEMPLATE_URL = '/tiktok-flowers-template.xlsx';
const TEMPLATE_SHEET = 'Template';
const HEADER_ROW = 2;     // 0-based; Excel row 3 holds the column titles
const DATA_START_ROW = 6; // 0-based; Excel rows 1–6 are template chrome
const LAST_COL = 61;      // 62 columns, A..BJ

// Column indexes in the Template sheet (named by TemplateConfig row 1).
const COL = {
  category: 0,
  brand: 1,
  name: 2,
  description: 3,
  mainImage: 4,
  weightLb: 28,
  lengthIn: 29,
  widthIn: 30,
  heightIn: 31,
  price: 33,
  quantity: 35,
  sku: 36,
  indoorOutdoor: 51,
  containsLiquid: 52,
  commonName: 53,
  scientificName: 54,
  dangerous: 55,
  prop65Repro: 56,
  prop65Carcinogen: 58,
  status: 61,
};

// Group a sale's TC items into one listing row per species. Items without
// a speciesId group by their denormalized variety+name instead.
export function groupTcForListing(saleItems, speciesById) {
  const groups = new Map();
  for (const it of saleItems) {
    if (it.type !== 'tc') continue;
    const key = it.speciesId || `n:${(it.variety || '').toLowerCase()}|${(it.name || '').toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      const sp = it.speciesId ? speciesById?.get?.(it.speciesId) : null;
      g = {
        key,
        name: it.name || sp?.epithet || '',
        variety: it.variety || '',
        commonName: sp?.commonName || '',
        sku: it.sku || '',
        imageUrl: it.imageUrl || '',
        price: null,
        count: 0,
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (g.price == null) {
      // A zero price is "not priced yet", not a free plantlet — TikTok
      // would happily list it at $0. Only positive prices count.
      const p = it.listingPrice ?? it.idealPrice;
      if (p != null && p !== '' && Number(p) > 0) g.price = Number(p);
    }
    if (!g.imageUrl && it.imageUrl) g.imageUrl = it.imageUrl;
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// One group → the 62-column row (sparse array, index = template column).
function listingRow(g, pkg) {
  const fullName = [g.variety, g.name].filter(Boolean).join(' ');
  const row = [];
  row[COL.category] = CATEGORY;
  row[COL.brand] = 'No brand';
  row[COL.name] = `${fullName} Tissue Culture Plantlet Live Plant`.slice(0, 255);
  row[COL.description] = [
    `${fullName} — tissue culture plantlet.`,
    `• Healthy lab-propagated ${g.name} plantlet`,
    '• Genetically identical to the mother plant',
    '• Carefully packed for shipping; acclimation guide included',
    '• Grown and shipped from our own nursery',
  ].join('\n');
  if (g.imageUrl) row[COL.mainImage] = g.imageUrl;
  row[COL.weightLb] = pkg.weightLb;
  row[COL.lengthIn] = pkg.lengthIn;
  row[COL.widthIn] = pkg.widthIn;
  row[COL.heightIn] = pkg.heightIn;
  if (g.price != null) row[COL.price] = g.price;
  row[COL.quantity] = g.count;
  row[COL.sku] = g.sku;
  row[COL.indoorOutdoor] = 'Indoor';
  row[COL.containsLiquid] = 'No';
  row[COL.commonName] = g.commonName || g.name;
  row[COL.scientificName] = fullName;
  row[COL.dangerous] = 'No';
  row[COL.prop65Repro] = 'No';
  row[COL.prop65Carcinogen] = 'No';
  row[COL.status] = 'Active(1)';
  return row;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// \p{L}\p{N} keeps Chinese (and any other script) sale names in the
// filename instead of collapsing them to dashes.
const fileStamp = (sale) =>
  `tiktok-${(sale?.name || 'live').replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}`;

// Seller Center upload file: the real template with data rows appended.
export async function downloadTikTokXlsx(sale, groups, pkg, showToast) {
  try {
    const XLSX = await import('xlsx');
    const resp = await fetch(TEMPLATE_URL);
    if (!resp.ok) throw new Error('TikTok template missing from the app bundle');
    const wb = XLSX.read(await resp.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[TEMPLATE_SHEET];
    if (!sheet) throw new Error('Template sheet not found in the workbook');

    groups.forEach((g, i) => {
      const row = listingRow(g, pkg);
      row.forEach((v, c) => {
        if (v === undefined || v === null || v === '') return;
        sheet[XLSX.utils.encode_cell({ r: DATA_START_ROW + i, c })] = {
          t: typeof v === 'number' ? 'n' : 's',
          v,
        };
      });
    });
    // The template ships with a truncated !ref (A3:AB6) — expand it to
    // cover the chrome AND the appended data or readers drop our rows.
    sheet['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: DATA_START_ROW + Math.max(groups.length, 1), c: LAST_COL },
    });

    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(
      new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `${fileStamp(sale)}.xlsx`,
    );
    return true;
  } catch (e) {
    showToast?.(e.message || 'TikTok export failed', 'error');
    return false;
  }
}

// CSV twin: the template's own header titles + the same rows. BOM keeps
// Chinese species names intact when Excel opens it.
export async function downloadTikTokCsv(sale, groups, pkg, showToast) {
  try {
    const XLSX = await import('xlsx');
    const resp = await fetch(TEMPLATE_URL);
    if (!resp.ok) throw new Error('TikTok template missing from the app bundle');
    const wb = XLSX.read(await resp.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[TEMPLATE_SHEET];
    const headers = [];
    for (let c = 0; c <= LAST_COL; c++) {
      headers.push(String(sheet[XLSX.utils.encode_cell({ r: HEADER_ROW, c })]?.v ?? ''));
    }
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(esc).join(',')];
    for (const g of groups) {
      const row = listingRow(g, pkg);
      lines.push(headers.map((_, c) => esc(row[c] ?? '')).join(','));
    }
    downloadBlob(
      new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
      `${fileStamp(sale)}.csv`,
    );
    return true;
  } catch (e) {
    showToast?.(e.message || 'TikTok CSV export failed', 'error');
    return false;
  }
}
