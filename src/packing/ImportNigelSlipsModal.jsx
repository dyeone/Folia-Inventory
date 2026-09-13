import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Upload, FileText, Loader2, CheckCircle2, AlertTriangle, Truck, Store,
  ArrowRight, Trash2, Package,
} from 'lucide-react';
import { api } from '../api.js';
import { shortBoxCode } from '../labels/boxCode.js';
import { bytesToBase64 } from '../labels/useBridgePrint.js';
import { urlToBytes } from './labelPdf.js';
import { parseNigelSlipFiles, terminateNigelParser, carrierFromMethod } from './parseNigelSlips.js';
import { isNigelBoxId, NIGEL_PREFIX } from './platform.js';

// Import Nigel's order slips.
//
// The desk drops the PDF Nigel exports from his BoyGardening shop (one
// order per page). Every page is OCR'd (parseNigelSlips.js) into an order:
// number, customer, line items, ship-to address, delivery method. The desk
// reviews and corrects each order — OCR is good but not perfect — then
// imports. Import does two things per order:
//   1. creates an OPEN BOX of placeholder items (same UNMATCHED-… /
//      lotKind 'unmatched' convention as Validate Sales, so the packer's
//      barcode-less "Pack" button, box delete/purge and sale-eval exclusion
//      all work unchanged), stamped with the buyer, ship-to and order #;
//      orders for the same recipient+address share one box, and an order
//      folds into an already-open Nigel box for that recipient;
//   2. stores the order's original slip page(s) on the box (pdf-lib page
//      copy — vector, prints crisp) via api.saveBoxSlip, so the packer can
//      print the slip at pack time and the desk can open it here.
// Box ids carry the `ng…` nonce (platform.js) — that prefix is what turns
// the box hot pink in both UIs and fences it off from Palmstreet/TikTok
// merges.

const groupKeyFor = (recipientName, street1, city, state, zip) => [
  String(recipientName || '').toLowerCase().trim(),
  String(street1 || '').toLowerCase().trim(),
  String(city || '').toLowerCase().trim(),
  String(state || '').toLowerCase().trim(),
  String(zip || '').toLowerCase().trim(),
].join('|');

function newUploadId() {
  return `${NIGEL_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function fmtPlaced(iso, raw) {
  if (raw) return raw;
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; }
}

const STATUS = {
  ok: { cls: 'bg-emerald-100 text-emerald-800 ring-emerald-300', label: 'Read OK' },
  check: { cls: 'bg-amber-100 text-amber-800 ring-amber-300', label: 'Check — something was unclear' },
  dupe: { cls: 'bg-sky-100 text-sky-800 ring-sky-300', label: 'Already imported' },
  error: { cls: 'bg-rose-100 text-rose-800 ring-rose-300', label: 'Could not read' },
};

// Cut the pages of one box's orders out of the uploaded PDFs into a fresh
// PDF (lossless page copy). `existing` = the box's current slip bytes when
// an order is folding into a box that already has one — those pages go first.
async function buildBoxSlipPdf(files, rows, existing) {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  if (existing) {
    try {
      const prev = await PDFDocument.load(existing, { ignoreEncryption: true });
      (await out.copyPages(prev, prev.getPageIndices())).forEach((p) => out.addPage(p));
    } catch { /* unreadable old slip — the new pages still get stored */ }
  }
  const cache = new Map();
  for (const row of rows) {
    const file = files.find((f) => f.index === row.fileIndex);
    if (!file || !row.pageIndexes?.length) continue;
    if (!cache.has(file.index)) cache.set(file.index, await PDFDocument.load(file.bytes, { ignoreEncryption: true }));
    const src = cache.get(file.index);
    const pages = await out.copyPages(src, row.pageIndexes.filter((i) => i >= 0 && i < src.getPageCount()));
    pages.forEach((p) => out.addPage(p));
  }
  if (out.getPageCount() === 0) return null;
  return bytesToBase64(await out.save());
}

export function ImportNigelSlipsModal({ openBoxes = [], inventoryItems = [], boxNotesByBox = {}, onClose, onDone, showToast }) {
  const [phase, setPhase] = useState('drop'); // drop | parsing | review | saving | done
  const [progress, setProgress] = useState(null);
  const [rows, setRows] = useState([]);
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [zoomSrc, setZoomSrc] = useState(null);
  const fileInputRef = useRef(null);

  // Free the OCR worker (and its model) when the modal unmounts.
  useEffect(() => () => { terminateNigelParser(); }, []);

  // Open Nigel boxes by recipient+address — an order for the same person
  // at the same address folds into that box instead of opening another.
  const openNigelBoxByGroup = useMemo(() => {
    const m = new Map();
    for (const b of openBoxes) {
      if (!isNigelBoxId(b.id)) continue;
      const a = b.buyerAddress || {};
      const key = groupKeyFor(b.buyer, a.street1, a.city, a.state, a.zip);
      if (!m.has(key)) m.set(key, b.id);
    }
    return m;
  }, [openBoxes]);

  // Order numbers already living in a Nigel box (open or shipped) — a
  // re-upload of the same export must not mint duplicates.
  const importedOrderBox = useMemo(() => {
    const m = new Map();
    for (const it of inventoryItems) {
      if (it.deletedAt || !it.orderId || !isNigelBoxId(it.shipmentBoxId)) continue;
      if (!m.has(String(it.orderId))) m.set(String(it.orderId), it.shipmentBoxId);
    }
    return m;
  }, [inventoryItems]);

  const handleFiles = async (fileList) => {
    const picked = Array.from(fileList || []).filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!picked.length) {
      showToast?.('Please drop the order-slip PDF');
      return;
    }
    setPhase('parsing');
    setProgress({ page: 0, pageCount: 0, fileName: picked[0]?.name, fileIndex: 0, fileCount: picked.length });
    let parsed;
    try {
      parsed = await parseNigelSlipFiles(picked, (p) => setProgress(p));
    } catch (e) {
      showToast?.(`Could not read the slips: ${e.message || 'unknown error'}`);
      setPhase('drop');
      return;
    }
    setFiles(parsed.files);
    setRows(parsed.orders.map((o) => {
      const dupeBox = o.orderNumber ? importedOrderBox.get(String(o.orderNumber)) : null;
      const status = o.error ? 'error' : dupeBox ? 'dupe' : o.needsReview ? 'check' : 'ok';
      return {
        ...o,
        status,
        dupeBox: dupeBox || null,
        include: status !== 'error' && status !== 'dupe' && !!o.recipientName && o.items.length > 0,
      };
    }));
    setPhase('review');
  };

  const onPickFile = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const updateRow = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  // Box plan for the included rows: which orders share a box, and whether
  // that box already exists (open Nigel box for the same recipient+address).
  const plan = useMemo(() => {
    const byKey = new Map();
    for (const r of rows) {
      if (!r.include) continue;
      const key = groupKeyFor(r.recipientName, r.street1, r.city, r.state, r.zip);
      if (!byKey.has(key)) byKey.set(key, { key, existingBoxId: openNigelBoxByGroup.get(key) || null, rows: [] });
      byKey.get(key).rows.push(r);
    }
    const rowBox = new Map();
    for (const g of byKey.values()) for (const r of g.rows) rowBox.set(r.id, g);
    return { groups: [...byKey.values()], rowBox };
  }, [rows, openNigelBoxByGroup]);

  const readyRows = rows.filter((r) => r.include && r.recipientName && r.items.length > 0);
  const newBoxCount = plan.groups.filter((g) => !g.existingBoxId).length;
  const mergeCount = plan.groups.length - newBoxCount;

  const handleImport = async () => {
    setPhase('saving');
    const uploadId = newUploadId();
    const now = new Date().toISOString();
    const out = { boxes: [], slipErrors: [], itemError: null };

    // 1. Placeholder items — one upsert for the whole import.
    const inserts = [];
    const boxRows = new Map(); // boxId → { rows, existing }
    for (const g of plan.groups) {
      const boxId = g.existingBoxId || `${uploadId}|${g.key}`;
      boxRows.set(boxId, { rows: g.rows, existing: !!g.existingBoxId });
      for (const r of g.rows) {
        const { carrier } = carrierFromMethod(r.deliveryMethod);
        const buyerAddress = {
          street1: r.street1 || '',
          street2: r.street2 || '',
          city: r.city || '',
          state: r.state || '',
          zip: r.zip || '',
          country: r.country || 'US',
          shipmentMethod: r.deliveryMethod || '',
          phone: r.phone || '',
          email: r.email || '',
        };
        r.items.forEach((it, idx) => {
          inserts.push({
            // Deterministic per order line: a re-import of the same order
            // into the same box replaces its placeholders (server self-heal
            // on UNMATCHED-* SKU collisions) instead of duplicating them.
            sku: `UNMATCHED-${boxId.slice(0, 12)}-o${r.orderNumber || 'x'}-l${idx + 1}`,
            type: 'plant',
            name: String(it.title || 'Order line').slice(0, 200),
            quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
            status: 'sold',
            lotKind: 'unmatched',
            lotNumber: null,
            saleId: null,
            salePrice: it.unitPrice > 0 ? it.unitPrice : 0,
            soldAt: r.placedAt || now,
            buyer: r.recipientName,
            buyerUsername: '',
            buyerAddress,
            shipmentBoxId: boxId,
            shipmentCarrier: carrier === 'ups' ? 'ups' : 'usps',
            orderId: r.orderNumber || null,
            orderDate: r.placedAt || null,
            // The Shipping tab sums orderShippingFee across a box's items,
            // so the order's fee rides on its first line only.
            orderShippingFee: idx === 0 && r.shippingFee != null ? r.shippingFee : null,
            notes: (it.options || []).filter(Boolean).join(' · ') || null,
          });
        });
      }
    }
    try {
      if (inserts.length > 0) await api.upsertItems(inserts);
    } catch (e) {
      out.itemError = e.message || 'Creating the boxes failed';
      setResults(out);
      setPhase('done');
      showToast?.(out.itemError);
      return;
    }

    // 2. One slip PDF per box — the order pages, behind any pages the box
    //    already had. A slip failure doesn't undo the box: the desk can
    //    re-import the same order later (placeholders self-heal) to retry.
    let n = 0;
    for (const [boxId, { rows: rs, existing }] of boxRows) {
      n++;
      setProgress({ page: n, pageCount: boxRows.size, fileName: rs[0]?.recipientName || '' });
      try {
        let prev = null;
        if (existing && boxNotesByBox?.[boxId]?.slipStoragePath) {
          try { prev = await urlToBytes(await api.getLabelUrl(boxId, 'slip')); } catch { prev = null; }
        }
        const base64 = await buildBoxSlipPdf(files, rs, prev);
        if (!base64) throw new Error('No slip pages for this box');
        await api.saveBoxSlip(boxId, base64);
        out.boxes.push({ boxId, existing, orders: rs.map((r) => r.orderNumber), slip: true });
      } catch (e) {
        out.boxes.push({ boxId, existing, orders: rs.map((r) => r.orderNumber), slip: false });
        out.slipErrors.push({ boxId, error: e.message || 'Slip save failed' });
      }
    }
    setResults(out);
    setPhase('done');
    const created = out.boxes.filter((b) => !b.existing).length;
    const merged = out.boxes.length - created;
    showToast?.(`Imported ${readyRows.length} order${readyRows.length === 1 ? '' : 's'} — ${created} new box${created === 1 ? '' : 'es'}${merged ? `, ${merged} added to open boxes` : ''}`);
    try { await onDone?.(); } catch { /* parent handles its own errors */ }
  };

  const readCount = rows.filter((r) => r.status !== 'error').length;
  const checkCount = rows.filter((r) => r.status === 'check').length;
  const dupeCount = rows.filter((r) => r.status === 'dupe').length;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 sm:p-6">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-200">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-[#ff69b4] text-white">
            <Store className="w-4 h-4" />
          </span>
          <h2 className="text-lg font-semibold text-gray-900">Import Nigel's order slips</h2>
          <span className="text-sm text-gray-500 hidden sm:inline">BoyGardening</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {phase === 'drop' && (
            <div className="p-5">
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition ${
                  dragOver ? 'border-[#ff69b4] bg-pink-50' : 'border-gray-300 hover:border-[#ff69b4] hover:bg-pink-50/40'
                }`}
              >
                <Upload className="w-10 h-10 mx-auto text-[#ff69b4] mb-3" />
                <div className="text-base font-medium text-gray-900">Drop the order-slip PDF here, or click to choose</div>
                <div className="text-sm text-gray-500 mt-1">
                  One order per page. Each order becomes an open box, and its slip is saved on the box for the packer to print.
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  onChange={onPickFile}
                  className="hidden"
                />
              </div>
              <p className="text-xs text-gray-500 mt-4 leading-relaxed">
                The slips are read with OCR (they have no text layer), so you'll review every order — name, address,
                items — before anything is created. Orders already imported are recognised by their order number and skipped.
              </p>
            </div>
          )}

          {(phase === 'parsing' || phase === 'saving') && (
            <div className="p-10 text-center">
              <Loader2 className="w-8 h-8 mx-auto text-[#ff69b4] animate-spin mb-3" />
              <div className="text-base font-medium text-gray-900">
                {phase === 'parsing' ? 'Reading slips…' : 'Creating boxes & saving slips…'}
              </div>
              {progress && (
                <div className="text-sm text-gray-500 mt-1">
                  {phase === 'parsing'
                    ? `${progress.fileCount > 1 ? `File ${(progress.fileIndex ?? 0) + 1}/${progress.fileCount} · ` : ''}${progress.fileName || ''}${progress.pageCount > 0 ? ` — page ${progress.page}/${progress.pageCount}` : ''}`
                    : `Box ${progress.page} of ${progress.pageCount}${progress.fileName ? ` · ${progress.fileName}` : ''}`}
                </div>
              )}
              {phase === 'parsing' && (
                <div className="text-xs text-gray-400 mt-3">Two reads per page — the first page takes a few seconds while the reader loads.</div>
              )}
            </div>
          )}

          {phase === 'review' && (
            <div className="p-4 sm:p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm text-gray-600 flex-wrap">
                <span className="font-medium text-gray-900">{readCount} order{readCount === 1 ? '' : 's'} read</span>
                <span className="text-gray-400">·</span>
                <span>{newBoxCount} new box{newBoxCount === 1 ? '' : 'es'}</span>
                {mergeCount > 0 && (
                  <>
                    <span className="text-gray-400">·</span>
                    <span>{mergeCount} added to open box{mergeCount === 1 ? '' : 'es'}</span>
                  </>
                )}
                {checkCount > 0 && (
                  <>
                    <span className="text-gray-400">·</span>
                    <span className="text-amber-700">{checkCount} to check</span>
                  </>
                )}
                {dupeCount > 0 && (
                  <>
                    <span className="text-gray-400">·</span>
                    <span className="text-sky-700">{dupeCount} already imported</span>
                  </>
                )}
              </div>

              {rows.map((row) => (
                <OrderRow
                  key={row.id}
                  row={row}
                  group={plan.rowBox.get(row.id) || null}
                  onChange={(patch) => updateRow(row.id, patch)}
                  onZoom={(src) => src && setZoomSrc(src)}
                />
              ))}
            </div>
          )}

          {phase === 'done' && results && (
            <div className="p-6 space-y-4">
              {results.itemError ? (
                <div className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-4">
                  <AlertTriangle className="w-6 h-6 text-rose-600 shrink-0" />
                  <div className="text-sm text-rose-800">
                    <div className="font-semibold">Nothing was imported.</div>
                    <div>{results.itemError}</div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="w-7 h-7 text-emerald-600" />
                    <div className="text-lg font-semibold text-gray-900">
                      {results.boxes.length} box{results.boxes.length === 1 ? '' : 'es'} ready for the packer
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {results.boxes.map((b) => (
                      <div key={b.boxId} className="flex items-center gap-2 text-sm">
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-[#ff69b4] text-white">
                          <Store className="w-3 h-3" /> Nigel
                        </span>
                        <span className="font-mono text-gray-700">{shortBoxCode(b.boxId)}</span>
                        <span className="text-gray-500">
                          {b.existing ? 'added to open box' : 'new box'} · order{b.orders.length === 1 ? '' : 's'} #{b.orders.filter(Boolean).join(', #')}
                        </span>
                        {b.slip
                          ? <span className="text-[11px] text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">slip saved</span>
                          : <span className="text-[11px] text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded">slip not saved</span>}
                      </div>
                    ))}
                  </div>
                  {results.slipErrors.length > 0 && (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 space-y-1">
                      <div className="text-sm font-semibold text-rose-800">Some slips could not be saved — the boxes exist, but the packer can't print these:</div>
                      {results.slipErrors.map((e) => (
                        <div key={e.boxId} className="text-sm text-rose-800">
                          <span className="font-mono">{shortBoxCode(e.boxId)}</span>: {e.error}
                        </div>
                      ))}
                      <div className="text-xs text-rose-700">Re-import the same PDF to retry — already-created boxes are recognised and only the slip is saved again.</div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-gray-200 flex items-center gap-3">
          {phase === 'review' && (
            <>
              <button
                onClick={() => { setRows([]); setFiles([]); setPhase('drop'); }}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2"
              >
                Start over
              </button>
              <div className="ml-auto flex items-center gap-3">
                <span className="text-sm text-gray-500">{readyRows.length} ready</span>
                <button
                  onClick={handleImport}
                  disabled={readyRows.length === 0}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-[#ff69b4] text-white hover:bg-[#ff1493] active:bg-[#e0117f] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Import {readyRows.length} order{readyRows.length === 1 ? '' : 's'} <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
          {phase === 'done' && (
            <button
              onClick={onClose}
              className="ml-auto inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
            >
              Done
            </button>
          )}
          {(phase === 'drop' || phase === 'parsing' || phase === 'saving') && (
            <button
              onClick={onClose}
              disabled={phase === 'saving'}
              className="ml-auto text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2 disabled:opacity-40"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Zoomed slip page */}
      {zoomSrc && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-6"
          onClick={() => setZoomSrc(null)}
        >
          <img src={zoomSrc} alt="Order slip" className="max-h-full max-w-full rounded-lg shadow-2xl bg-white" />
        </div>
      )}
    </div>,
    document.body,
  );
}

const inputCls = 'w-full text-sm px-2 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:border-[#ff69b4] bg-white';

function OrderRow({ row, group, onChange, onZoom }) {
  if (row.status === 'error' && row.items?.length === 0 && !row.recipientName) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3">
        <button type="button" onClick={() => onZoom(row.thumbs?.[0])} className="shrink-0 w-12 h-16 rounded-md border border-rose-200 overflow-hidden bg-white">
          {row.thumbs?.[0] ? <img src={row.thumbs[0]} alt="" className="w-full h-full object-cover" /> : <FileText className="w-5 h-5 m-auto text-rose-300" />}
        </button>
        <div className="text-sm text-rose-800">
          <span className="font-medium">{row.fileName}</span>
          {row.pageIndexes?.length ? ` (page ${row.pageIndexes[0] + 1})` : ''} — {row.error || 'Could not read this page'}
        </div>
      </div>
    );
  }

  const st = STATUS[row.status] || STATUS.ok;
  const { carrier } = carrierFromMethod(row.deliveryMethod);
  const sharesBox = group && group.rows.length > 1;
  const setItem = (idx, patch) => onChange({ items: row.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) });
  const removeItem = (idx) => onChange({ items: row.items.filter((_, i) => i !== idx) });

  return (
    <div className={`rounded-xl border p-3 flex gap-3 ${row.include ? 'border-[#ff69b4]/60 bg-white' : 'border-gray-200 bg-gray-50'}`}>
      {/* Page thumbnail(s) */}
      <div className="shrink-0 flex flex-col gap-1">
        {(row.thumbs || []).slice(0, 3).map((t, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onZoom(t)}
            className="w-16 h-[5.5rem] rounded-md border border-gray-200 overflow-hidden bg-gray-50 hover:ring-2 hover:ring-[#ff69b4]/60"
            title="Click to enlarge"
          >
            <img src={t} alt="Slip page" className="w-full h-full object-cover object-top" />
          </button>
        ))}
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ring-1 ${st.cls}`}>
            {st.label}
          </span>
          {row.deliveryMethod && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
              <Truck className="w-3 h-3" /> {row.deliveryMethod}{row.deliveryDays ? ` · ${row.deliveryDays}` : ''}
              <span className="uppercase text-gray-400">· {carrier}</span>
            </span>
          )}
          {row.status === 'dupe' && row.dupeBox && (
            <span className="text-[11px] text-sky-700">in box {shortBoxCode(row.dupeBox)}</span>
          )}
          {row.include && group?.existingBoxId && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#c0106b]">
              <Package className="w-3 h-3" /> adds to open box {shortBoxCode(group.existingBoxId)}
            </span>
          )}
          {row.include && !group?.existingBoxId && sharesBox && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#c0106b]">
              <Package className="w-3 h-3" /> shares a box with order{group.rows.length > 2 ? 's' : ''} #{group.rows.filter((r) => r.id !== row.id).map((r) => r.orderNumber || '?').join(', #')}
            </span>
          )}
          <label className="ml-auto flex items-center gap-1.5 text-sm text-gray-700 shrink-0 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!row.include}
              onChange={(e) => onChange({ include: e.target.checked })}
              className="w-4 h-4 accent-[#ff69b4]"
            />
            Import
          </label>
        </div>

        {/* Order # + customer line */}
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="text-gray-500">Order #</span>
          <input
            value={row.orderNumber || ''}
            onChange={(e) => onChange({ orderNumber: e.target.value.replace(/\D/g, '') })}
            placeholder="number"
            className="w-24 text-sm font-mono px-2 py-1 border border-gray-300 rounded-lg focus:outline-none focus:border-[#ff69b4]"
            spellCheck={false}
          />
          {fmtPlaced(row.placedAt, row.placedRaw) && <span className="text-gray-500">placed {fmtPlaced(row.placedAt, row.placedRaw)}</span>}
          {(row.customerName || row.email) && (
            <span className="text-gray-400 truncate" title={[row.customerName, row.email, row.phone].filter(Boolean).join(' · ')}>
              · {[row.customerName, row.email].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>

        {/* Ship to */}
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-1.5">
          <input value={row.recipientName || ''} onChange={(e) => onChange({ recipientName: e.target.value })} placeholder="Recipient" className={`${inputCls} col-span-2 font-medium`} />
          <input value={row.phone || ''} onChange={(e) => onChange({ phone: e.target.value })} placeholder="Phone" className={`${inputCls} col-span-2 sm:col-span-2`} />
          <input value={row.deliveryMethod || ''} onChange={(e) => onChange({ deliveryMethod: e.target.value })} placeholder="Delivery method" className={`${inputCls} col-span-2 sm:col-span-2`} />
          <input value={row.street1 || ''} onChange={(e) => onChange({ street1: e.target.value })} placeholder="Street" className={`${inputCls} col-span-2 sm:col-span-3`} />
          <input value={row.street2 || ''} onChange={(e) => onChange({ street2: e.target.value })} placeholder="Apt / unit" className={`${inputCls} col-span-2 sm:col-span-3`} />
          <input value={row.city || ''} onChange={(e) => onChange({ city: e.target.value })} placeholder="City" className={`${inputCls} col-span-2 sm:col-span-3`} />
          <input value={row.state || ''} onChange={(e) => onChange({ state: e.target.value.toUpperCase().slice(0, 2) })} placeholder="ST" className={`${inputCls} sm:col-span-1`} />
          <input value={row.zip || ''} onChange={(e) => onChange({ zip: e.target.value })} placeholder="ZIP" className={`${inputCls} sm:col-span-2`} />
        </div>

        {/* Items */}
        <div className="space-y-1">
          {row.items.length === 0 && (
            <div className="flex items-center gap-1.5 text-[12px] text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5" /> No items were read — this order can't be imported.
            </div>
          )}
          {row.items.map((it, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <input
                value={it.title || ''}
                onChange={(e) => setItem(idx, { title: e.target.value })}
                placeholder="Item"
                className={`${inputCls} flex-1 min-w-0`}
              />
              <span className="text-xs text-gray-400">×</span>
              <input
                type="number"
                min={1}
                value={it.quantity || 1}
                onChange={(e) => setItem(idx, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                className="w-14 text-sm px-2 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:border-[#ff69b4] bg-white tabular-nums"
              />
              {it.options?.length > 0 && (
                <span className="hidden sm:inline text-[11px] text-gray-500 truncate max-w-[10rem]" title={it.options.join(' · ')}>{it.options.join(' · ')}</span>
              )}
              <button
                type="button"
                onClick={() => removeItem(idx)}
                aria-label="Remove line"
                className="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-rose-600 hover:bg-rose-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {row.itemCount != null && row.items.length !== row.itemCount && row.status !== 'error' && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-700">
              <AlertTriangle className="w-3.5 h-3.5" /> The slip says {row.itemCount} item{row.itemCount === 1 ? '' : 's'}, {row.items.length} read — check against the page.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
