import { useEffect, useRef, useState } from 'react';
import { Ruler, Loader2, Settings, Sparkles } from 'lucide-react';
import { api } from '../api.js';

// Per-box packaging + live rate comparison. The operator picks the box
// size (from the Shipping Settings catalog), sets the weight, and picks
// one of three services; "Get rates" then quotes that box from BOTH Shippo
// and ShipStation side by side so they can pick the cheaper one.
//
// Selections persist via onSavePackaging(patch) — the parent owns the
// shipment_boxes write + the boxNotesByBox cache, mirroring box notes.
// Rate results are ephemeral (not stored) since prices move.

// Display mirror of api/_lib/services.js. The server owns the provider
// code mapping; the panel only needs key + label + a carrier tint.
const SERVICES = [
  { key: 'usps_priority', label: 'USPS Priority', carrier: 'usps' },
  { key: 'ups_2nd_day_air', label: 'UPS 2nd Day Air', carrier: 'ups' },
  { key: 'ups_next_day_air_saver', label: 'UPS Next Day Air Saver', carrier: 'ups' },
];

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

export function BoxPackagingPanel({ box, boxSizes = [], onSavePackaging, showToast }) {
  const sizeId = box.boxSizeId || '';
  const serviceKey = box.serviceKey || '';
  const selectedSize = boxSizes.find(s => s.id === sizeId) || null;

  // Weight is a free text draft so typing stays smooth; we commit on blur.
  // Re-sync from props only while the field isn't focused (avoids stomping
  // mid-edit when the parent cache refreshes).
  const [weightDraft, setWeightDraft] = useState(box.weightOz != null ? String(box.weightOz) : '');
  const weightFocused = useRef(false);
  useEffect(() => {
    if (!weightFocused.current) setWeightDraft(box.weightOz != null ? String(box.weightOz) : '');
  }, [box.weightOz]);

  const [rates, setRates] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const save = async (patch) => {
    try { await onSavePackaging?.(patch); }
    catch (e) { showToast?.(e?.message || 'Save failed'); }
  };

  const onPickSize = (id) => {
    const preset = boxSizes.find(s => s.id === id) || null;
    const patch = { boxSizeId: id || null };
    // Seed the weight from the preset's default the first time, if blank.
    if (preset && preset.weightOz != null && !weightDraft.trim()) {
      patch.weightOz = preset.weightOz;
      setWeightDraft(String(preset.weightOz));
    }
    setRates(null); setErr('');
    save(patch);
  };

  const commitWeight = () => {
    weightFocused.current = false;
    const n = parseFloat(weightDraft);
    const next = Number.isFinite(n) && n > 0 ? n : null;
    if ((box.weightOz ?? null) !== next) { setRates(null); save({ weightOz: next }); }
  };

  const onPickService = (key) => save({ serviceKey: key === serviceKey ? null : key });

  const dims = selectedSize
    ? { length: selectedSize.length, width: selectedSize.width, height: selectedSize.height }
    : null;
  const weightOz = parseFloat(weightDraft) || (selectedSize?.weightOz ?? 0);
  const canQuote = !!dims && weightOz > 0;

  const getRates = async () => {
    if (!canQuote || loading) return;
    setLoading(true); setErr(''); setRates(null); setMeta(null);
    try {
      const resp = await api.getRates({ shipmentBoxId: box.id, dims, weightOz });
      setRates(resp?.rates || []);
      setMeta({
        shippoConfigured: resp?.shippoConfigured,
        shippoError: resp?.shippoError,
        shipstationError: resp?.shipstationError,
      });
    } catch (e) {
      setErr(e?.message || 'Could not fetch rates');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-4 py-3 border-t border-gray-100 bg-slate-50/60 space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
        <Ruler className="w-3.5 h-3.5 text-gray-500" /> Packaging &amp; rates
      </div>

      {boxSizes.length === 0 ? (
        <div className="flex items-start gap-2 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg p-2.5">
          <Settings className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
          <span>No box sizes defined yet. An admin can add them in <strong>Shipping Settings → Box sizes</strong>, then pick one here to compare rates.</span>
        </div>
      ) : (
        <>
          {/* Box size + weight */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[10rem]">
              <div className="text-[11px] font-medium text-gray-600 mb-1">Box size</div>
              <select
                value={sizeId}
                onChange={(e) => onPickSize(e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">Select a box…</option>
                {boxSizes.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.length}×{s.width}×{s.height}in
                  </option>
                ))}
              </select>
            </label>
            <label className="w-24">
              <div className="text-[11px] font-medium text-gray-600 mb-1">Weight (oz)</div>
              <input
                type="number"
                inputMode="decimal"
                value={weightDraft}
                onFocus={() => { weightFocused.current = true; }}
                onChange={(e) => setWeightDraft(e.target.value)}
                onBlur={commitWeight}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                placeholder={selectedSize?.weightOz != null ? String(selectedSize.weightOz) : '—'}
                className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </label>
          </div>

          {/* Service selector */}
          <div>
            <div className="text-[11px] font-medium text-gray-600 mb-1">Service</div>
            <div className="flex flex-wrap gap-1.5">
              {SERVICES.map(svc => {
                const active = serviceKey === svc.key;
                return (
                  <button
                    key={svc.key}
                    type="button"
                    onClick={() => onPickService(svc.key)}
                    className={`text-xs font-medium px-2.5 py-1 rounded-md border transition ${
                      active
                        ? svc.carrier === 'ups'
                          ? 'bg-amber-100 border-amber-300 text-amber-900'
                          : 'bg-blue-100 border-blue-300 text-blue-900'
                        : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {svc.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Get rates */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={getRates}
              disabled={!canQuote || loading}
              title={canQuote ? 'Quote this box from Shippo and ShipStation' : 'Pick a box size and weight first'}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {loading ? 'Quoting…' : rates ? 'Refresh rates' : 'Get rates'}
            </button>
            {!canQuote && (
              <span className="text-[11px] text-gray-500">Pick a box size &amp; weight to compare.</span>
            )}
          </div>

          {err && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">{err}</div>
          )}

          {rates && <RateTable rates={rates} meta={meta} selectedKey={serviceKey} onPickService={onPickService} />}
        </>
      )}
    </div>
  );
}

// Side-by-side comparison grid. Each row is one service; columns are the
// two providers. The cheaper of the two is tinted emerald; the row that
// matches the box's selected service is outlined. Clicking a row selects
// that service.
function RateTable({ rates, meta, selectedKey, onPickService }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="grid grid-cols-[1fr_5rem_5rem] text-[10px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-200">
        <div className="px-2.5 py-1.5">Service</div>
        <div className="px-2.5 py-1.5 text-right">ShipStation</div>
        <div className="px-2.5 py-1.5 text-right">Shippo</div>
      </div>
      {rates.map(r => {
        const ss = r.shipstation?.amount ?? null;
        const shp = r.shippo?.amount ?? null;
        const selected = selectedKey === r.key;
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => onPickService(r.key)}
            className={`w-full grid grid-cols-[1fr_5rem_5rem] items-center text-left border-b border-gray-100 last:border-b-0 hover:bg-gray-50 ${
              selected ? 'bg-emerald-50/70' : ''
            }`}
          >
            <div className="px-2.5 py-1.5 flex items-center gap-1.5 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.provider === 'ups' ? 'bg-amber-500' : 'bg-blue-500'}`} />
              <span className="text-xs text-gray-800 truncate">{r.label}</span>
            </div>
            <div className={`px-2.5 py-1.5 text-right text-xs tabular-nums ${
              r.cheapest === 'shipstation' ? 'text-emerald-700 font-semibold' : 'text-gray-700'
            }`}>
              {money(ss)}
            </div>
            <div className={`px-2.5 py-1.5 text-right text-xs tabular-nums ${
              r.cheapest === 'shippo' ? 'text-emerald-700 font-semibold' : 'text-gray-700'
            }`}>
              {money(shp)}
              {r.shippo?.estDays != null && (
                <span className="block text-[10px] text-gray-400 font-normal">{r.shippo.estDays}d</span>
              )}
            </div>
          </button>
        );
      })}
      {(meta?.shipstationError || meta?.shippoError || meta?.shippoConfigured === false) && (
        <div className="px-2.5 py-1.5 border-t border-gray-100 space-y-0.5 bg-amber-50/50">
          {meta.shipstationError && (
            <div className="text-[11px] text-amber-800">ShipStation: {meta.shipstationError}</div>
          )}
          {meta.shippoConfigured === false ? (
            <div className="text-[11px] text-amber-800">Shippo not configured — add SHIPPO_API_TOKEN to compare its rates.</div>
          ) : meta.shippoError ? (
            <div className="text-[11px] text-amber-800">Shippo: {meta.shippoError}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
