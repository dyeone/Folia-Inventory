import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, Loader2 } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { api } from '../api.js';
import { MediaEditor } from './MediaEditor.jsx';
import { money, photosOf } from './pools.js';

const priceText = (i) => (Number(i?.listingPrice) > 0 ? String(i.listingPrice) : '');

// Step 2 of adding plants (and "Photos & video" on a pool): go through the
// plants one at a time — photos, video, price — then Next. Uploads run in
// the tab's background uploader, so Next never waits for them.
export function MediaWalkthrough({ ids, items, uploads, showToast, onMerged, onChanged, onClose }) {
  const byId = new Map((items || []).map((i) => [i.id, i]));
  const list = ids.map((id) => byId.get(id)).filter(Boolean);
  const [idx, setIdx] = useState(0);
  const [price, setPrice] = useState(() => priceText(list[0]));
  const [saving, setSaving] = useState(false);
  const stripRef = useRef(null);

  const at = Math.min(idx, Math.max(0, list.length - 1));
  const item = list[at];

  // Keep the current plant's chip in view.
  useEffect(() => {
    stripRef.current?.querySelector(`[data-idx="${at}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [at]);

  if (!item) {
    return (
      <Modal title="Photos & video" onClose={onClose} size="lg">
        <p className="text-sm text-gray-500 text-center py-6">These plants aren't in a pool any more.</p>
      </Modal>
    );
  }

  // Save a changed price before moving on. false = stay (bad price / failed).
  const commitPrice = async () => {
    const raw = price.trim();
    if (raw === priceText(item)) return true;
    if (raw === '') return true;
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v <= 0) { showToast('Enter a price above $0, or leave it empty', 'error'); return false; }
    const rounded = Math.round(v * 100) / 100;
    setSaving(true);
    try {
      await api.upsertItems([{ id: item.id, listingPrice: rounded }]);
      onMerged([{ id: item.id, listingPrice: rounded }]);
      onChanged?.(item.id);
      return true;
    } catch (err) {
      showToast(err.message || 'Could not save the price', 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Closing (X, tap outside) keeps a typed price too.
  const close = async () => { if (await commitPrice()) onClose(); };

  const go = async (next) => {
    if (next === at) return;
    if (!(await commitPrice())) return;
    if (next < 0 || next >= list.length) { onClose(); return; }
    setIdx(next);
    setPrice(priceText(list[next]));
  };

  const pending = (id) => uploads.jobs.some((j) => j.itemId === id);
  const done = (i) => photosOf(i).length > 0 && !!i.videoUrl;
  const last = at === list.length - 1;
  const queued = uploads.jobs.length;

  return (
    <Modal title={`Photos & video · ${at + 1} of ${list.length}`} onClose={close} size="lg">
      <div className="space-y-4">
        {list.length > 1 && (
          <div ref={stripRef} className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
            {list.map((i, n) => (
              <button
                key={i.id} type="button" data-idx={n} onClick={() => go(n)}
                className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full border text-xs font-mono font-bold ${
                  n === at ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200'
                }`}
              >
                {pending(i.id)
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : done(i) ? <Check className={`w-3 h-3 ${n === at ? 'text-green-300' : 'text-green-600'}`} /> : null}
                {i.saleCode || i.sku}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          {item.saleCode && (
            <span className="px-2.5 py-1 rounded-lg bg-gray-900 text-white font-mono font-bold text-xl tracking-wider shrink-0">{item.saleCode}</span>
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900 truncate">{item.listingDetails?.title || item.name || item.sku}</div>
            <div className="text-[11px] text-gray-500 truncate"><span className="font-mono">{item.sku}</span>{item.variety ? ` · ${item.variety}` : ''}</div>
          </div>
        </div>

        <MediaEditor key={item.id} item={item} uploads={uploads} showToast={showToast} onMerged={onMerged} onChanged={onChanged} />

        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Price {Number(item.listingPrice) > 0 && <span className="font-normal text-gray-400">now {money(item.listingPrice)}</span>}</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
            <input
              type="number" inputMode="decimal" min="0" step="1" value={price}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(at + 1); } }}
              className="input pl-7 text-base" placeholder="Set later"
            />
          </div>
        </div>

        <div className="sticky bottom-0 -mx-4 sm:-mx-5 -mb-4 sm:-mb-5 px-4 sm:px-5 py-3 bg-white border-t border-gray-200 space-y-1.5">
          <div className="flex gap-2">
            <button
              type="button" disabled={at === 0 || saving} onClick={() => go(at - 1)}
              className="px-4 py-3 rounded-xl border border-gray-300 text-sm font-semibold text-gray-800 disabled:opacity-40 flex items-center gap-1"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <button
              type="button" disabled={saving} onClick={() => go(at + 1)}
              className="flex-1 py-3 rounded-xl bg-emerald-600 active:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {last ? 'Done' : <>Next plant <ChevronRight className="w-4 h-4" /></>}
            </button>
          </div>
          <p className="text-[11px] text-gray-500 text-center">
            {queued ? `${queued} upload${queued === 1 ? '' : 's'} still going — they finish in the background, keep the app open.` : 'Photos and videos upload in the background — no need to wait.'}
          </p>
        </div>
      </div>
    </Modal>
  );
}
