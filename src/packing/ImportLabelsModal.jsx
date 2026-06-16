import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Upload, FileText, Loader2, CheckCircle2, AlertTriangle, Truck,
  ScanLine, ImageOff, ArrowRight,
} from 'lucide-react';
import { api } from '../api.js';
import { shortBoxCode } from '../labels/boxCode.js';
import { parseLabelFiles, terminateLabelParser } from './parseShippingLabel.js';
import { matchLabelToBoxes } from './matchLabels.js';

// Import Shipping Labels.
//
// The operator drops the label PDFs they downloaded from Palmstreet/Shippo.
// For each label we decode the tracking barcode and OCR the recipient block,
// then auto-match it to an open box by name/username/address. The operator
// reviews the assignments (the label image is shown so they can eyeball any
// uncertain match), fixes anything off, and saves — which stores the tracking
// number + the label PDF on each box (api.recordPalmstreetTracking).

function addressLine(addr) {
  if (!addr) return '';
  return [addr.city, addr.state, String(addr.zip || '').slice(0, 5)].filter(Boolean).join(' ');
}

function boxLabel(box) {
  const who = box.buyer || (box.buyerUsername ? `@${box.buyerUsername}` : 'Box');
  const place = addressLine(box.buyerAddress);
  return `${shortBoxCode(box.id)} · ${who}${place ? ` · ${place}` : ''}`;
}

const CONFIDENCE = {
  high: { cls: 'bg-emerald-100 text-emerald-800 ring-emerald-300', label: 'Auto-matched' },
  medium: { cls: 'bg-sky-100 text-sky-800 ring-sky-300', label: 'Likely — check' },
  low: { cls: 'bg-amber-100 text-amber-800 ring-amber-300', label: 'Unsure — check' },
  none: { cls: 'bg-rose-100 text-rose-800 ring-rose-300', label: 'No match — pick' },
};

export function ImportLabelsModal({ openBoxes, shipmentsByBox = {}, onClose, onDone, showToast }) {
  const [phase, setPhase] = useState('drop'); // drop | parsing | review | saving | done
  const [progress, setProgress] = useState(null);
  const [rows, setRows] = useState([]);
  const [results, setResults] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [zoomSrc, setZoomSrc] = useState(null);
  const fileInputRef = useRef(null);

  // Free the OCR worker (and its model) when the modal unmounts.
  useEffect(() => () => { terminateLabelParser(); }, []);

  const boxOptions = useMemo(
    () => [...openBoxes]
      .sort((a, b) => (a.buyer || '').localeCompare(b.buyer || ''))
      .map((b) => ({ id: b.id, label: boxLabel(b) })),
    [openBoxes],
  );

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) {
      showToast?.('Please drop PDF shipping labels');
      return;
    }
    setPhase('parsing');
    setProgress({ page: 0, pageCount: files.length, fileName: files[0]?.name });
    let parsed;
    try {
      parsed = await parseLabelFiles(files, (p) => setProgress(p));
    } catch (e) {
      showToast?.(`Could not read labels: ${e.message || 'unknown error'}`);
      setPhase('drop');
      return;
    }
    setRows(parsed.map((label) => {
      if (label.error) return { ...label, boxId: '', include: false, confidence: 'none' };
      const match = matchLabelToBoxes(label, openBoxes);
      return {
        ...label,
        boxId: match.boxId || '',
        confidence: match.confidence,
        reasons: match.reasons,
        include: !!(match.boxId && label.trackingNumber),
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

  // Boxes targeted by more than one included row → flag the collision.
  const boxUsage = useMemo(() => {
    const m = {};
    for (const r of rows) {
      if (r.include && r.boxId) m[r.boxId] = (m[r.boxId] || 0) + 1;
    }
    return m;
  }, [rows]);

  const readyRows = rows.filter((r) => r.include && r.boxId && (r.trackingNumber || '').trim());

  const handleAssign = async () => {
    setPhase('saving');
    const out = [];
    for (const row of readyRows) {
      setProgress({ page: out.length + 1, pageCount: readyRows.length, fileName: row.fileName });
      try {
        await api.recordPalmstreetTracking(row.boxId, row.trackingNumber.trim(), {
          labelPdfBase64: row.pagePdfBase64,
          weightOz: row.weightOz,
        });
        out.push({ id: row.id, ok: true, boxId: row.boxId });
      } catch (e) {
        out.push({ id: row.id, ok: false, error: e.message || 'Save failed' });
      }
    }
    setResults(out);
    setPhase('done');
    const okCount = out.filter((r) => r.ok).length;
    showToast?.(`Assigned ${okCount} label${okCount === 1 ? '' : 's'}`);
    try { await onDone?.(); } catch { /* parent handles its own errors */ }
  };

  const matchedCount = rows.filter((r) => !r.error && r.boxId).length;
  const noBarcodeCount = rows.filter((r) => !r.error && !r.trackingNumber).length;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 sm:p-6">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-200">
          <Upload className="w-5 h-5 text-emerald-600" />
          <h2 className="text-lg font-semibold text-gray-900">Import shipping labels</h2>
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
                  dragOver ? 'border-emerald-500 bg-emerald-50' : 'border-gray-300 hover:border-emerald-400 hover:bg-gray-50'
                }`}
              >
                <Upload className="w-10 h-10 mx-auto text-emerald-500 mb-3" />
                <div className="text-base font-medium text-gray-900">Drop label PDFs here, or click to choose</div>
                <div className="text-sm text-gray-500 mt-1">
                  One or many files. Multi-page PDFs are split into one label per page.
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
                Each label's tracking barcode is read automatically, and the recipient is matched to an open
                box by name &amp; address. You'll review every assignment before anything is saved.
              </p>
            </div>
          )}

          {(phase === 'parsing' || phase === 'saving') && (
            <div className="p-10 text-center">
              <Loader2 className="w-8 h-8 mx-auto text-emerald-500 animate-spin mb-3" />
              <div className="text-base font-medium text-gray-900">
                {phase === 'parsing' ? 'Reading labels…' : 'Assigning labels…'}
              </div>
              {progress && (
                <div className="text-sm text-gray-500 mt-1">
                  {phase === 'parsing'
                    ? `${progress.fileCount > 1 ? `File ${(progress.fileIndex ?? 0) + 1}/${progress.fileCount} · ` : ''}${progress.fileName || ''}${progress.pageCount > 1 ? ` — page ${progress.page}/${progress.pageCount}` : ''}`
                    : `${progress.page} of ${progress.pageCount}`}
                </div>
              )}
              {phase === 'parsing' && (
                <div className="text-xs text-gray-400 mt-3">First label may take a few seconds while the reader loads.</div>
              )}
            </div>
          )}

          {phase === 'review' && (
            <div className="p-4 sm:p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm text-gray-600 flex-wrap">
                <span className="font-medium text-gray-900">{rows.length} label{rows.length === 1 ? '' : 's'}</span>
                <span className="text-gray-400">·</span>
                <span>{matchedCount} auto-matched</span>
                {noBarcodeCount > 0 && (
                  <>
                    <span className="text-gray-400">·</span>
                    <span className="text-amber-700">{noBarcodeCount} need a tracking #</span>
                  </>
                )}
              </div>

              {rows.map((row) => (
                <LabelRow
                  key={row.id}
                  row={row}
                  boxOptions={boxOptions}
                  duplicate={row.include && row.boxId && boxUsage[row.boxId] > 1}
                  replaces={!!shipmentsByBox?.[row.boxId]?.trackingNumber}
                  onChange={(patch) => updateRow(row.id, patch)}
                  onZoom={() => row.thumbnailDataUrl && setZoomSrc(row.thumbnailDataUrl)}
                />
              ))}
            </div>
          )}

          {phase === 'done' && (
            <div className="p-6">
              <div className="flex items-center gap-2.5 mb-4">
                <CheckCircle2 className="w-7 h-7 text-emerald-600" />
                <div className="text-lg font-semibold text-gray-900">
                  {results.filter((r) => r.ok).length} of {results.length} label{results.length === 1 ? '' : 's'} assigned
                </div>
              </div>
              {results.some((r) => !r.ok) && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 space-y-1">
                  {results.filter((r) => !r.ok).map((r) => {
                    const row = rows.find((x) => x.id === r.id);
                    return (
                      <div key={r.id} className="text-sm text-rose-800">
                        <span className="font-mono">{row?.boxId ? shortBoxCode(row.boxId) : '—'}</span>: {r.error}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-gray-200 flex items-center gap-3">
          {phase === 'review' && (
            <>
              <button
                onClick={() => { setRows([]); setPhase('drop'); }}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2"
              >
                Start over
              </button>
              <div className="ml-auto flex items-center gap-3">
                <span className="text-sm text-gray-500">{readyRows.length} ready</span>
                <button
                  onClick={handleAssign}
                  disabled={readyRows.length === 0}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Assign {readyRows.length} label{readyRows.length === 1 ? '' : 's'} <ArrowRight className="w-4 h-4" />
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

      {/* Zoomed label preview */}
      {zoomSrc && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-6"
          onClick={() => setZoomSrc(null)}
        >
          <img src={zoomSrc} alt="Label" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>,
    document.body,
  );
}

function LabelRow({ row, boxOptions, duplicate, replaces, onChange, onZoom }) {
  if (row.error) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3">
        <ImageOff className="w-5 h-5 text-rose-500 shrink-0" />
        <div className="text-sm text-rose-800">
          <span className="font-medium">{row.fileName}</span>
          {row.pageCount > 1 ? ` (page ${row.page})` : ''} — {row.error}
        </div>
      </div>
    );
  }

  const conf = CONFIDENCE[row.confidence] || CONFIDENCE.none;
  const recipientPeek = (row.ocrText || '').replace(/\s+/g, ' ').trim().slice(0, 90);

  return (
    <div className={`rounded-xl border p-3 flex gap-3 ${row.include ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50'}`}>
      {/* Thumbnail */}
      <button
        type="button"
        onClick={onZoom}
        className="shrink-0 w-16 h-24 rounded-md border border-gray-200 overflow-hidden bg-gray-50 flex items-center justify-center hover:ring-2 hover:ring-emerald-300"
        title="Click to enlarge"
      >
        {row.thumbnailDataUrl
          ? <img src={row.thumbnailDataUrl} alt="Label" className="w-full h-full object-cover" />
          : <FileText className="w-6 h-6 text-gray-300" />}
      </button>

      {/* Details */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ring-1 ${conf.cls}`}>
            {conf.label}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 uppercase">
            <Truck className="w-3 h-3" /> {row.carrier}
          </span>
          {row.weightOz != null && (
            <span className="text-[11px] text-gray-500">{row.weightOz} oz</span>
          )}
          {row.reasons?.length > 0 && (
            <span className="text-[11px] text-gray-400">matched on {row.reasons.join(', ')}</span>
          )}
        </div>

        {recipientPeek && (
          <div className="text-[11px] text-gray-400 truncate" title={recipientPeek}>read: {recipientPeek}</div>
        )}

        {/* Tracking number */}
        <div className="flex items-center gap-2">
          <ScanLine className={`w-4 h-4 shrink-0 ${row.trackingNumber ? 'text-emerald-600' : 'text-amber-500'}`} />
          <input
            value={row.trackingNumber || ''}
            onChange={(e) => {
              const trackingNumber = e.target.value;
              onChange({ trackingNumber, include: row.include || (!!trackingNumber.trim() && !!row.boxId) });
            }}
            placeholder="No barcode read — type tracking #"
            className="flex-1 min-w-0 text-sm font-mono px-2 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-500"
            spellCheck={false}
          />
          {row.trackingNumber && (
            <span
              className={`hidden sm:inline text-[11px] shrink-0 ${row.trackingSource === 'ocr' ? 'text-amber-600' : 'text-gray-400'}`}
              title={row.trackingSource === 'ocr' ? 'Read from the printed text — double-check it' : 'Decoded from the barcode'}
            >
              {row.trackingSource === 'ocr' ? 'from text' : 'from barcode'}
            </span>
          )}
        </div>

        {/* Box assignment */}
        <div className="flex items-center gap-2">
          <select
            value={row.boxId || ''}
            onChange={(e) => onChange({ boxId: e.target.value, include: !!e.target.value && !!row.trackingNumber })}
            className={`flex-1 min-w-0 text-sm px-2 py-1.5 border rounded-lg bg-white focus:outline-none focus:border-emerald-500 ${
              row.boxId ? 'border-gray-300 text-gray-900' : 'border-amber-300 text-gray-500'
            }`}
          >
            <option value="">— Choose a box —</option>
            {boxOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-gray-600 shrink-0 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={row.include}
              onChange={(e) => onChange({ include: e.target.checked })}
              className="w-4 h-4 accent-emerald-600"
            />
            Save
          </label>
        </div>

        {/* Inline warnings */}
        {duplicate && (
          <div className="flex items-center gap-1.5 text-[11px] text-rose-700">
            <AlertTriangle className="w-3.5 h-3.5" /> Another label is also assigned to this box.
          </div>
        )}
        {replaces && row.include && (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-700">
            <AlertTriangle className="w-3.5 h-3.5" /> This box already has a tracking # — saving replaces it.
          </div>
        )}
      </div>
    </div>
  );
}
