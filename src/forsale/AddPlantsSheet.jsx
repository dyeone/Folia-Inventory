import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Search, X, Loader2, ChevronRight } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { CameraScanner } from '../packing/CameraScanner.jsx';
import { POOLS, isForSale, money } from './pools.js';
import { findBySaleCode } from './saleCode.js';

const POOL_LABEL = Object.fromEntries(POOLS.map((p) => [p.id, p.label]));

// Step 1 of adding plants: scan their tags (camera or the bench scanner) or
// search by SKU / name, collect a list, add them to a pool in one go — each
// gets its short code on the way in. Step 2 (MediaWalkthrough, opened by the
// tab) goes through them one by one for photos, video and price.
export function AddPlantsSheet({ items, pool: initialPool, onAdd, onClose, showToast }) {
  const [pool, setPool] = useState(initialPool || 'palmstreet');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);       // ids, newest first
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const byId = useMemo(() => new Map((items || []).map((i) => [i.id, i])), [items]);

  // The bench scanner types into whatever has focus: focus the box on open
  // and after the camera closes — but not on a phone, where it would pop
  // the keyboard over the sheet.
  useEffect(() => {
    if (camera) return;
    const touch = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!touch) inputRef.current?.focus();
  }, [camera]);

  // Why a plant can't be picked, or '' when it can.
  const blocker = (i) => {
    if (!isForSale(i)) return i.shipmentBoxId ? 'in a shipping box' : `is ${i.status}`;
    if (i.salePool) return `already in the ${POOL_LABEL[i.salePool] || i.salePool} pool`;
    return '';
  };

  const pick = (i) => {
    const why = blocker(i);
    if (why) { showToast(`${i.saleCode || i.sku} ${why}`, 'error'); return false; }
    setPicked((p) => (p.includes(i.id) ? p : [i.id, ...p]));
    return true;
  };

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return (items || [])
      .filter((i) => isForSale(i))
      .filter((i) => [i.sku, i.name, i.variety, i.saleCode, i.listingDetails?.title]
        .some((f) => String(f || '').toLowerCase().includes(s)))
      .slice(0, 60);
  }, [items, q]);

  // A scan / Enter: exact SKU or plant code first, else the only search hit.
  const resolve = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return;
    const lower = s.toLowerCase();
    const hit = (items || []).find((i) => !i.deletedAt && String(i.sku || '').toLowerCase() === lower)
      || findBySaleCode(items, s);
    if (hit) {
      if (pick(hit)) { showToast(`Picked ${hit.sku}`); setQ(''); }
      return;
    }
    if (matches.length === 1) { if (pick(matches[0])) setQ(''); return; }
    showToast(`No plant "${s}"`, 'error');
  };


  const add = async (media) => {
    if (!picked.length) return;
    setBusy(media ? 'media' : 'plain');
    try {
      const ok = await onAdd(picked, pool, { media });
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  const pickedItems = picked.map((id) => byId.get(id)).filter(Boolean);

  return (
    <Modal title="Add plants to For Sale" onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {POOLS.map((p) => (
            <button
              key={p.id} type="button" onClick={() => setPool(p.id)}
              className={`py-2 rounded-lg border-2 text-sm font-semibold ${
                pool === p.id ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-gray-200 text-gray-600'
              }`}
            >
              {p.label} pool
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); resolve(q); } }}
              placeholder="Scan a tag, or type SKU / name"
              className="input pl-9 text-base"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
            />
          </div>
          <button
            type="button" onClick={() => setCamera(true)}
            className="px-3 rounded-lg bg-gray-900 text-white flex items-center gap-1.5 text-sm font-semibold"
          >
            <Camera className="w-4 h-4" /> Scan
          </button>
        </div>

        {matches.length > 0 && (
          <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-y-auto">
            {matches.map((i) => {
              const why = blocker(i);
              const on = picked.includes(i.id);
              return (
                <button
                  key={i.id} type="button" disabled={!!why}
                  onClick={() => (on ? setPicked((p) => p.filter((x) => x !== i.id)) : pick(i))}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left ${on ? 'bg-emerald-50' : ''} disabled:opacity-50`}
                >
                  <input type="checkbox" readOnly checked={on} disabled={!!why} className="shrink-0" />
                  {i.imageUrl ? <img src={i.imageUrl} alt="" className="w-9 h-9 rounded object-cover shrink-0" /> : <div className="w-9 h-9 rounded bg-gray-100 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-900 truncate">{i.name}</div>
                    <div className="text-[11px] text-gray-500 truncate">
                      <span className="font-mono">{i.sku}</span>{why ? ` · ${why}` : ` · ${money(i.listingPrice)}`}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div>
          <div className="text-xs font-semibold text-gray-600 mb-1">
            {pickedItems.length ? `${pickedItems.length} picked` : 'Nothing picked yet — scan tags or search above.'}
          </div>
          {pickedItems.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pickedItems.map((i) => (
                <span key={i.id} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full bg-gray-100 text-xs text-gray-800">
                  <span className="font-mono">{i.sku}</span>
                  <button type="button" aria-label={`Remove ${i.sku}`} onClick={() => setPicked((p) => p.filter((x) => x !== i.id))} className="p-0.5 rounded-full hover:bg-gray-200">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <button
          type="button" onClick={() => add(true)} disabled={!!busy || !pickedItems.length}
          className="w-full py-3 rounded-xl bg-emerald-600 active:bg-emerald-700 text-white font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {busy === 'media' && <Loader2 className="w-4 h-4 animate-spin" />}
          Add {pickedItems.length || ''} to {POOL_LABEL[pool]} · next: photos &amp; video
          <ChevronRight className="w-4 h-4" />
        </button>
        <button
          type="button" onClick={() => add(false)} disabled={!!busy || !pickedItems.length}
          className="w-full text-xs text-gray-500 underline disabled:opacity-40 disabled:no-underline flex items-center justify-center gap-1.5"
        >
          {busy === 'plain' && <Loader2 className="w-3 h-3 animate-spin" />}
          Just add them — photos later
        </button>
        <p className="text-[11px] text-gray-500 text-center">Each plant gets a short code (like KM42) for its tag. Next you'll go through them one by one: several photos, one video and a price each.</p>
      </div>
      {camera && (
        <CameraScanner
          onScan={(text) => { setCamera(false); resolve(text); }}
          onClose={() => setCamera(false)}
        />
      )}
    </Modal>
  );
}
