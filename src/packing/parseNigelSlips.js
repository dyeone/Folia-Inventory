// Client-side parser for Nigel's (BoyGardening) order slips.
//
// Nigel exports his shop's orders as one PDF, one order per page: an
// "Order #NNNNN (N items)" header, the customer line, the line items with
// price × qty, the totals, then a two-column "Customer Details" block
// (Delivery Address on the left, Billing Address on the right) and the
// Delivery Method. The PDF has NO text layer — the text is vector glyph
// outlines (pdftotext returns nothing, pdffonts lists no fonts) — so, like
// the carrier labels in parseShippingLabel.js, every page is rendered to a
// canvas and OCR'd with tesseract.js.
//
// Two OCR passes per page:
//   1. the full page — header, customer line, items, totals, method;
//   2. the LEFT HALF only — the Delivery Address block. On a full-page pass
//      tesseract reads the two address columns as interleaved lines
//      ("Joe Butt Joseph Butt", "…Washington, District of Washington…"),
//      so the delivery column is read alone.
// Before OCR the coloured product thumbnails are painted white: tesseract
// hallucinates junk tokens from them ("ST CARRIE COMBO", "ee fof Seedlings").
// Everything on the page is black-on-white except those images, so
// "coloured blob" is a reliable detector.
//
// pdfjs + tesseract are big; they're loaded lazily, only when the operator
// opens the import modal. Nothing here throws for a single bad page — the
// page surfaces as an error row the operator can fix or skip.

import { getPdfjs } from './pdfjsLoader.js';
import { normalizeUsState, normalizeCountry, isKnownUsState } from './usState.js';

// ── lazy OCR worker (own singleton — its lifetime is the import modal's) ──

let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker('eng');
    })().catch((e) => { ocrWorkerPromise = null; throw e; });
  }
  return ocrWorkerPromise;
}

export async function terminateNigelParser() {
  if (ocrWorkerPromise) {
    const p = ocrWorkerPromise;
    ocrWorkerPromise = null;
    try { (await p).terminate(); } catch { /* already gone */ }
  }
}

// ── text parsing (pure — unit-tested in Node against real OCR output) ───

const ORDER_HEADER_RE = /Order\s*#\s*(\d{3,})\s*\(\s*(\d+)\s*items?\s*\)/i;
// `"Dark Lullaby" (Spring 2026) $95.00 x1 $95.00`
const ITEM_LINE_RE = /^(.+?)\s+\$\s?([\d,]+(?:\.\d{1,2})?)\s+[xX×]\s?(\d+)\s+\$\s?([\d,]+(?:\.\d{1,2})?)\s*$/;
const TOTALS_START_RE = /^Items\s+\$/i;
const PHONE_RE = /^\+?[\d][\d\s().-]{6,}$/;

function money(s) {
  const n = parseFloat(String(s || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function cleanLines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// "Sep 8, 2026, 7:09 PM" → ISO string (local time). Wix prints the shop's
// local time; we only need the day for orderDate/soldAt.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parsePlacedDate(raw) {
  const m = String(raw || '').match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s*(\d{1,2}):(\d{2})\s*([AP]M)?)?/i);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon == null) return null;
  let h = m[4] ? parseInt(m[4], 10) : 12;
  const min = m[5] ? parseInt(m[5], 10) : 0;
  const ap = (m[6] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const d = new Date(parseInt(m[3], 10), mon, parseInt(m[2], 10), h, min, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Strip OCR residue from a product title: stray 1–2 char tokens glued on by
// a thumbnail edge, unbalanced leading punctuation, doubled spaces.
export function cleanTitle(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  // Leading junk before the first quote when the title is a quoted name
  // (`ST "Cosmic War"` → `"Cosmic War"`); but keep real words like
  // `CARRIE COMBO: "PQ" + "DP"` (3+ letters before the quote, no colon lost).
  const q = s.indexOf('"');
  if (q > 0) {
    const pre = s.slice(0, q).trim();
    if (pre.length <= 2 || /^[^A-Za-z0-9]+$/.test(pre)) s = s.slice(q);
  }
  s = s.replace(/^[^A-Za-z0-9"(]+/, '').trim();
  return s;
}

// The "# of Seedlings: 1-Pack" style option line under an item. OCR often
// mangles the leading "#" ("ee fof Seedlings", "= # of Seedlings").
export function cleanOptionLine(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  // "# of Seedlings: 1-Pack" with up to one 1–3 letter crumb and a lost or
  // misread "#" in front ("ee fof Seedlings: 1-Pack", "= # of Seedlings…").
  const m = s.match(/^[^A-Za-z]*(?:[a-z]{1,3}\s+)?(?:#\s*)?f?(of\s+[A-Za-z][^:]*:.*)$/i);
  if (m) return `# ${m[1]}`.trim();
  return s.replace(/^[^A-Za-z0-9#"(]+/, '').trim();
}

// Split a comma-joined US address into parts, anchored on the one part
// that reads "<State> <ZIP>" so OCR line-wraps inside the street never move
// the city. Returns needsReview=true when no state/zip anchor was found.
export function splitUsAddress(str) {
  const out = { street1: '', street2: '', city: '', state: '', zip: '', country: '', needsReview: false };
  const parts = String(str || '').split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) { out.needsReview = true; return out; }
  // Country — last part, if it's one we know.
  const last = parts[parts.length - 1];
  const country = normalizeCountry(last);
  if (country !== last || /^[A-Z]{2}$/.test(last)) { out.country = country; parts.pop(); }
  // "<State> <ZIP>" anchor, searched from the end.
  let anchor = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
    if (m && isKnownUsState(m[1])) {
      out.state = normalizeUsState(m[1]);
      out.zip = m[2];
      anchor = i;
      break;
    }
  }
  if (anchor === -1) {
    // Maybe the zip sits alone ("Florida", "32789") or the state and zip
    // were read as separate parts — try state-only followed by a zip part.
    for (let i = parts.length - 1; i >= 1; i--) {
      if (/^\d{5}(?:-\d{4})?$/.test(parts[i]) && isKnownUsState(parts[i - 1])) {
        out.state = normalizeUsState(parts[i - 1]);
        out.zip = parts[i];
        parts.splice(i, 1);
        anchor = i - 1;
        break;
      }
    }
  }
  if (anchor === -1) {
    out.street1 = parts.join(', ');
    out.needsReview = true;
    return out;
  }
  out.city = parts[anchor - 1] || '';
  const street = parts.slice(0, Math.max(0, anchor - 1));
  out.street1 = street[0] || '';
  out.street2 = street.slice(1).join(', ');
  if (!out.street1 || !out.city) out.needsReview = true;
  return out;
}

// Delivery Address block from the LEFT-HALF OCR text:
//   Delivery Address / <name> / <address lines…> / <phone?> / Delivery Method
export function parseAddressBlock(leftText) {
  const lines = cleanLines(leftText);
  const start = lines.findIndex((l) => /^Delivery\s+Address/i.test(l));
  const end = lines.findIndex((l, i) => i > start && /^Delivery\s+Method/i.test(l));
  const block = start === -1 ? [] : lines.slice(start + 1, end === -1 ? undefined : end);
  // Guard: a stray "Billing Address" (right column bleeding in) ends the block.
  const billing = block.findIndex((l) => /^Billing\s+Address/i.test(l));
  const body = billing === -1 ? block : block.slice(0, billing);
  if (body.length === 0) return { recipientName: '', phone: '', ...splitUsAddress(''), found: false };
  const recipientName = body[0];
  let phone = '';
  const rest = body.slice(1);
  if (rest.length && PHONE_RE.test(rest[rest.length - 1])) phone = rest.pop();
  const addr = splitUsAddress(rest.join(' ').replace(/\s+,/g, ','));
  return { recipientName, phone, ...addr, found: true };
}

export function parseDeliveryMethod(text) {
  const lines = cleanLines(text);
  const i = lines.findIndex((l) => /^Delivery\s+Method/i.test(l));
  if (i === -1) return { method: '', days: '' };
  const method = lines[i + 1] || '';
  const days = /business\s+day/i.test(lines[i + 2] || '') ? lines[i + 2] : '';
  return { method, days };
}

// One page's full-page OCR text → order header + items + totals. isOrderStart
// is false for a continuation page (an order too long for one page): its
// items are appended to the previous order by the caller.
export function parseOrderText(fullText) {
  const lines = cleanLines(fullText);
  const out = {
    isOrderStart: false,
    orderNumber: '', itemCount: null,
    customerName: '', email: '', phone: '',
    placedAt: null, placedRaw: '',
    items: [],
    shippingFee: null, total: null, paidWith: '',
  };
  let i = 0;
  const hIdx = lines.findIndex((l) => ORDER_HEADER_RE.test(l));
  if (hIdx !== -1 && hIdx < 6) {
    const m = lines[hIdx].match(ORDER_HEADER_RE);
    out.isOrderStart = true;
    out.orderNumber = m[1];
    out.itemCount = parseInt(m[2], 10);
    i = hIdx + 1;
    // Customer line: "Name, email, phone" (any order after the name).
    const cust = lines[i] || '';
    if (cust && !/^Placed on/i.test(cust)) {
      const parts = cust.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
      out.customerName = parts[0] || '';
      for (const p of parts.slice(1)) {
        if (!out.email && /@/.test(p)) out.email = p.replace(/\s+/g, '');
        else if (!out.phone && PHONE_RE.test(p)) out.phone = p;
      }
      i++;
    }
    const placed = lines[i] || '';
    const pm = placed.match(/^Placed\s+on\s+(.+)$/i);
    if (pm) { out.placedRaw = pm[1]; out.placedAt = parsePlacedDate(pm[1]); i++; }
  }
  // Items run until the totals block ("Items $…") or the customer block.
  let current = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (TOTALS_START_RE.test(line) || /^Customer\s+Details/i.test(line)) break;
    const im = line.match(ITEM_LINE_RE);
    if (im) {
      current = {
        title: cleanTitle(im[1]),
        unitPrice: money(im[2]),
        quantity: Math.max(1, parseInt(im[3], 10) || 1),
        lineTotal: money(im[4]),
        options: [],
      };
      out.items.push(current);
      continue;
    }
    // A price-less line in the items area is the current item's option
    // line (or its wrapped title). Ignore 1–2 char OCR crumbs.
    if (current && line.replace(/[^A-Za-z0-9]/g, '').length >= 3) {
      current.options.push(cleanOptionLine(line));
    }
  }
  // Totals.
  for (; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^Shipping\s+\$\s?([\d,]+(?:\.\d{1,2})?)/i))) out.shippingFee = money(m[1]);
    else if ((m = line.match(/^Total\s+\$\s?([\d,]+(?:\.\d{1,2})?)/i))) out.total = money(m[1]);
    else if ((m = line.match(/^Paid\s+with\s+(.+)$/i))) out.paidWith = m[1];
    if (/^Customer\s+Details/i.test(line)) break;
  }
  return out;
}

// Carrier + UPS service hint from the shop's delivery-method label.
export function carrierFromMethod(method) {
  const m = String(method || '').toUpperCase();
  if (/\bUPS\b/.test(m)) {
    if (/NEXT\s*DAY/.test(m)) return { carrier: 'ups', serviceKey: 'ups_next_day_air' };
    return { carrier: 'ups', serviceKey: 'ups_2nd_day_air' };
  }
  if (/FED\s?EX/.test(m)) return { carrier: 'fedex', serviceKey: null };
  return { carrier: 'usps', serviceKey: null };
}

// ── thumbnail masking (pure over ImageData — testable in Node) ───────────

// Paint every photo-like blob white. Works on a coarse cell grid: a cell
// is "photo" when enough of its pixels have real chroma (max−min of RGB) —
// or, for a dark/greyscale product shot, when it is nearly solid dark
// (text strokes never fill 70% of an 8px cell; a divider rule is 1 px).
// 4-connected photo cells form a blob; each blob's bounding box (plus a
// one-cell halo) is filled white. Returns the number of blobs masked.
export function maskColorBlobs(imageData, { cell = 8, chromaMin = 48, cellFrac = 0.12, darkFrac = 0.7 } = {}) {
  const { data, width, height } = imageData;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const counts = new Uint16Array(cols * rows);
  const darks = new Uint16Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const rowBase = Math.floor(y / cell) * cols;
    let idx = y * width * 4;
    for (let x = 0; x < width; x++, idx += 4) {
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const c = rowBase + ((x / cell) | 0);
      if (mx - mn > chromaMin) counts[c]++;
      if (mx < 110) darks[c]++;
    }
  }
  const thr = cell * cell * cellFrac;
  const darkThr = cell * cell * darkFrac;
  const isPhoto = (i) => counts[i] >= thr || darks[i] >= darkThr;
  const seen = new Uint8Array(cols * rows);
  const stack = [];
  let blobs = 0;
  for (let start = 0; start < counts.length; start++) {
    if (!isPhoto(start) || seen[start]) continue;
    let minC = cols, maxC = -1, minR = rows, maxR = -1, n = 0, chroma = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const cur = stack.pop();
      n++;
      if (counts[cur] >= thr) chroma++;
      const c = cur % cols;
      const r = (cur - c) / cols;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      const nbs = [];
      if (c > 0) nbs.push(cur - 1);
      if (c < cols - 1) nbs.push(cur + 1);
      if (r > 0) nbs.push(cur - cols);
      if (r < rows - 1) nbs.push(cur + cols);
      for (const nb of nbs) {
        if (!seen[nb] && isPhoto(nb)) { seen[nb] = 1; stack.push(nb); }
      }
    }
    if (n < 2) continue; // a lone speck — leave it
    // A dark-only blob must be photo-shaped (≥ 6×6 cells ≈ 48 px square):
    // a bold heading's strokes also read as dense cells, but they form a
    // thin run, never a square patch.
    if (chroma === 0 && (maxC - minC < 5 || maxR - minR < 5)) continue;
    const x0 = Math.max(0, (minC - 1) * cell);
    const y0 = Math.max(0, (minR - 1) * cell);
    const x1 = Math.min(width, (maxC + 2) * cell);
    const y1 = Math.min(height, (maxR + 2) * cell);
    for (let y = y0; y < y1; y++) {
      let p = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++, p += 4) {
        data[p] = 255; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = 255;
      }
    }
    blobs++;
  }
  return blobs;
}

// ── rendering (browser only) ─────────────────────────────────────────────

// ~190 dpi for an A4 page (2200 px tall): plenty for 10–12 pt body text,
// small enough that two OCR passes per page stay a few seconds each.
function renderScale(page) {
  const base = page.getViewport({ scale: 1 });
  return Math.min(3, Math.max(1.5, 2200 / base.height));
}

async function renderPage(page) {
  const viewport = page.getViewport({ scale: renderScale(page) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function whiteoutThumbnails(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const n = maskColorBlobs(img);
  if (n > 0) ctx.putImageData(img, 0, 0);
  return n;
}

function makeThumb(canvas, targetW = 320) {
  const scale = Math.min(1, targetW / canvas.width);
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.72);
}

async function ocr(canvas, rectangle) {
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(canvas, rectangle ? { rectangle } : undefined);
    return data?.text || '';
  } catch {
    return '';
  }
}

function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── orchestrator ─────────────────────────────────────────────────────────

// files: File[] (PDFs). Resolves { orders, files } where each order carries
// its parsed fields, the file it came from, its 0-based page indexes (a
// long order can span two pages) and a JPEG thumbnail per page. `files`
// keeps each upload's raw bytes so the modal can cut per-box PDFs later
// (pdf-lib copyPages — lossless, the vector pages print crisp).
export async function parseNigelSlipFiles(files, onProgress) {
  const pdfjs = await getPdfjs();
  const list = Array.from(files || []);
  const orders = [];
  const keptFiles = [];
  for (let f = 0; f < list.length; f++) {
    const file = list[f];
    let buf;
    let doc;
    try {
      buf = await file.arrayBuffer();
      doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    } catch (e) {
      orders.push({ id: uid(), fileIndex: f, fileName: file.name, pageIndexes: [], thumbs: [], error: `Could not open PDF: ${e?.message || 'unknown error'}` });
      continue;
    }
    keptFiles.push({ index: f, name: file.name, bytes: new Uint8Array(buf) });
    const pageCount = doc.numPages;
    let current = null;
    for (let p = 1; p <= pageCount; p++) {
      onProgress?.({ fileIndex: f, fileCount: list.length, fileName: file.name, page: p, pageCount });
      let canvas;
      try {
        const page = await doc.getPage(p);
        canvas = await renderPage(page);
      } catch (e) {
        orders.push({ id: uid(), fileIndex: f, fileName: file.name, pageIndexes: [p - 1], thumbs: [], error: `Page ${p} failed to render: ${e?.message || 'unknown'}` });
        current = null;
        continue;
      }
      whiteoutThumbnails(canvas);
      const thumb = makeThumb(canvas);
      const fullText = await ocr(canvas);
      const leftText = await ocr(canvas, { left: 0, top: 0, width: Math.round(canvas.width * 0.5), height: canvas.height });
      canvas.width = 0; canvas.height = 0; // release the backing store

      const parsed = parseOrderText(fullText);
      const addr = parseAddressBlock(leftText);
      const method = parseDeliveryMethod(leftText || fullText);

      if (parsed.isOrderStart || !current) {
        current = {
          id: uid(),
          fileIndex: f,
          fileName: file.name,
          pageIndexes: [p - 1],
          thumbs: [thumb],
          orderNumber: parsed.orderNumber,
          itemCount: parsed.itemCount,
          customerName: parsed.customerName,
          email: parsed.email,
          phone: parsed.phone || addr.phone,
          placedAt: parsed.placedAt,
          placedRaw: parsed.placedRaw,
          items: parsed.items,
          shippingFee: parsed.shippingFee,
          total: parsed.total,
          paidWith: parsed.paidWith,
          recipientName: addr.recipientName,
          street1: addr.street1,
          street2: addr.street2,
          city: addr.city,
          state: addr.state,
          zip: addr.zip,
          country: addr.country || 'US',
          deliveryMethod: method.method,
          deliveryDays: method.days,
          addressFound: addr.found,
          needsReview: !parsed.isOrderStart || addr.needsReview || !addr.found || parsed.items.length === 0,
          ocrText: fullText,
          ocrLeftText: leftText,
        };
        if (!parsed.isOrderStart) current.error = 'No "Order #" header found on this page';
        orders.push(current);
      } else {
        // Continuation of the previous order (long item list): append items
        // and adopt the address/method if this page is the one carrying them.
        current.pageIndexes.push(p - 1);
        current.thumbs.push(thumb);
        current.items.push(...parsed.items);
        if (parsed.shippingFee != null) current.shippingFee = parsed.shippingFee;
        if (parsed.total != null) current.total = parsed.total;
        if (addr.found) {
          Object.assign(current, {
            recipientName: addr.recipientName, street1: addr.street1, street2: addr.street2,
            city: addr.city, state: addr.state, zip: addr.zip, country: addr.country || 'US',
            phone: current.phone || addr.phone, addressFound: true,
          });
          current.needsReview = addr.needsReview || current.items.length === 0;
        }
        if (method.method) { current.deliveryMethod = method.method; current.deliveryDays = method.days; }
        current.ocrText += `\n${fullText}`;
        current.ocrLeftText += `\n${leftText}`;
      }
    }
    try { await doc.destroy(); } catch { /* best effort */ }
  }
  return { orders, files: keptFiles };
}
