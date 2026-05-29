import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Tag, ScanLine, Search, X, Loader2, ImagePlus, Trash2, Calendar, Plus, Check,
} from 'lucide-react';
import { api } from '../api.js';

// Pre Sale — stage individual inventory items into an upcoming sale event's
// lineup by SKU (scan or type), and attach per-item photos. The target sale
// is chosen from a dropdown of non-closed events (soonest first). Staging an
// item just sets its saleId; photos go through the item-photo endpoints
// (api.uploadItemPhoto / listItemPhotos / deleteItemPhoto) backed by the
// item_photos table — see migration 0019 + api/species-photos.js.
//
// Saving prefers the parent's proven lineup-save handler (onStageItems, same
// partial-update shape LineupBuilder emits) so item-column invariants are
// respected; if it isn't wired it falls back to a direct upsert of the full
// row, which is safe against both the insert and update paths.

// How many eligible rows to render in the browse list before asking the user
// to narrow with search — keeps the DOM light on big inventories.
const BROWSE_CAP = 200;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const r = String(reader.result || '');
      const comma = r.indexOf(',');
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.readAsDataURL(file);
  });
}

// Sort key: soonest upcoming first. Falls back to the free-text date, then
// pushes undated sales to the end.
function saleSortKey(s) {
  const t = s.startTime ? Date.parse(s.startTime) : (s.date ? Date.parse(s.date) : NaN);
  return Number.isNaN(t) ? Infinity : t;
}

// Trailing numeric part of a SKU (e.g. ANT-2303 -> 2303) so the browse list
// shows newest inventory first; non-numeric SKUs sort last.
function skuNum(sku) {
  const m = /-(\d+)\s*$/.exec(sku || '');
  return m ? parseInt(m[1], 10) : -1;
}

export function PreSaleTab({ sales, items, showToast, onStageItems, onItemsChanged }) {
  const openSales = useMemo(
    () => sales.filter(s => s.status !== 'closed').slice().sort((a, b) => saleSortKey(a) - saleSortKey(b)),
    [sales],
  );

  // Selected sale. We derive the effective id at render time (defaulting to
  // the soonest open sale) rather than syncing it through an effect, so a
  // stale or cleared selection self-heals without a setState-in-effect.
  const [saleSel, setSaleSel] = useState('');
  const saleId = (saleSel && openSales.some(s => s.id === saleSel))
    ? saleSel
    : (openSales[0]?.id || '');
  const sale = openSales.find(s => s.id === saleId) || null;

  // Local overlay of saleId assignments so the staged list updates instantly
  // even if the parent doesn't refetch. Maps itemId -> saleId|null override.
  const [override, setOverride] = useState({});
  const effSaleId = (it) => (it.id in override ? override[it.id] : it.saleId);

  const [scanInput, setScanInput] = useState('');
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef(null);

  useEffect(() => { scanRef.current?.focus(); }, [saleId]);
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(() => setMsg(null), 2500);
    return () => clearTimeout(t);
  }, [msg]);

  const flash = (type, text) => {
    setMsg({ type, text });
    if (type === 'error') showToast?.(text, 'error');
  };

  const staged = useMemo(() => {
    if (!saleId) return [];
    return items
      .filter(it => (it.id in override ? override[it.id] : it.saleId) === saleId)
      .slice()
      .sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));
  }, [items, saleId, override]);

  const eligibleToAdd = (it) => {
    const cur = effSaleId(it);
    if (cur === saleId) return { ok: false, reason: 'Already staged' };
    if (cur && cur !== saleId) return { ok: false, reason: `${it.sku} is already on another sale` };
    if (!['available', 'listed'].includes(it.status)) {
      return { ok: false, reason: `${it.sku} is ${it.status}, not available` };
    }
    if (sale?.itemTypes === 'tc' && it.type !== 'tc') return { ok: false, reason: `${it.sku} is not a TC; this sale is TC only` };
    if (sale?.itemTypes === 'plant' && it.type !== 'plant') return { ok: false, reason: `${it.sku} is not a plant; this sale is plants only` };
    return { ok: true };
  };

  const assign = async (it, toSaleId) => {
    setBusy(true);
    setOverride(p => ({ ...p, [it.id]: toSaleId }));
    try {
      // Removing from a sale also clears its lot number (mirrors the lineup
      // builder), so a re-add starts clean.
      const patch = { id: it.id, saleId: toSaleId, lotKind: 'sale' };
      if (!toSaleId) patch.lotNumber = null;
      if (onStageItems) {
        await onStageItems([patch]);
      } else {
        // Standalone fallback (no parent handler): the /items POST does an
        // UPDATE for rows with an id, so this partial patch is safe.
        await api.upsertItems([patch]);
        onItemsChanged?.();
      }
      return true;
    } catch (e) {
      setOverride(p => ({ ...p, [it.id]: it.saleId })); // rollback
      flash('error', e.message || 'Save failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addItem = async (it) => {
    if (!saleId) { flash('error', 'Pick a sale event first'); return; }
    const elig = eligibleToAdd(it);
    if (!elig.ok) { flash(elig.reason === 'Already staged' ? 'ok' : 'error', elig.reason); return; }
    if (await assign(it, saleId)) flash('ok', `Added ${it.sku}`);
  };

  const addBySku = async (raw) => {
    const code = (raw || '').trim();
    if (!code) return;
    const found = items.find(i => i.sku?.toLowerCase() === code.toLowerCase());
    if (!found) { flash('error', `No SKU "${code}" in inventory`); return; }
    await addItem(found);
  };

  const removeFromSale = async (it) => {
    if (await assign(it, null)) flash('ok', `Removed ${it.sku}`);
  };

  // Everything eligible to add to the selected sale (not already staged here),
  // narrowed by the search box. Newest SKUs first.
  const available = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = items.filter(it => {
      if (!eligibleToAdd(it).ok) return false;
      if (!q) return true;
      return (
        it.sku?.toLowerCase().includes(q) ||
        it.name?.toLowerCase().includes(q) ||
        it.variety?.toLowerCase().includes(q)
      );
    });
    rows.sort((a, b) => skuNum(b.sku) - skuNum(a.sku));
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, saleId, override, sale?.itemTypes]);

  const availableShown = available.slice(0, BROWSE_CAP);

  if (openSales.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
        <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-3" />
        <p className="text-gray-500 text-sm">
          No upcoming sale events. Create one first, then stage items here for it.
        </p>
      </div>
    );
  }

  const stagedValue = staged.reduce((s, i) => s + (parseFloat(i.listingPrice) || 0), 0);

  return (
    <div className="space-y-3">
      {/* Sale picker + scanner */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <label className="block flex-1 min-w-0">
            <span className="text-sm font-medium text-gray-700 block mb-1.5">Next sale event</span>
            <div className="relative">
              <Calendar className="w-4 h-4 text-emerald-600 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select
                value={saleId}
                onChange={(e) => setSaleSel(e.target.value)}
                className="w-full appearance-none pl-9 pr-9 py-3 text-sm font-medium border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              >
                {openSales.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.date ? ` · ${s.date}` : ''}{s.itemTypes && s.itemTypes !== 'both' ? ` · ${s.itemTypes.toUpperCase()} only` : ''}
                  </option>
                ))}
              </select>
              <svg className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </label>
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2.5 self-start sm:self-auto">
            <span className="text-sm text-emerald-800">
              <span className="font-semibold">{staged.length}</span> staged
            </span>
            <span className="text-emerald-300">·</span>
            <span className="text-sm font-semibold text-emerald-700">${stagedValue.toFixed(0)}</span>
          </div>
        </div>

        <div className="relative">
          <ScanLine className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-emerald-600" />
          <input
            ref={scanRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addBySku(scanInput); setScanInput(''); }
            }}
            placeholder="Scan or type a SKU, then Enter to stage it"
            className="w-full pl-10 pr-3 py-3 text-base border-2 border-emerald-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-500 bg-white"
          />
          {msg && (
            <div className={`absolute right-2 top-1/2 -translate-y-1/2 text-xs sm:text-sm px-2 py-1 rounded ${
              msg.type === 'error' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
            }`}>
              {msg.text}
            </div>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-3 items-start">
        {/* Available inventory — always visible, click to stage */}
        <div className="bg-white rounded-xl border border-gray-200 flex flex-col">
          <div className="p-3 border-b border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-900">
                Available inventory
                <span className="ml-1.5 text-xs font-normal text-gray-500">({available.length})</span>
              </h3>
              {sale?.itemTypes && sale.itemTypes !== 'both' && (
                <span className="text-[11px] text-gray-500 uppercase tracking-wide">{sale.itemTypes} only</span>
              )}
            </div>
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by SKU, name, variety…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
              />
            </div>
          </div>

          <div className="max-h-[480px] overflow-y-auto">
            {availableShown.length === 0 ? (
              <div className="px-3 py-10 text-center text-sm text-gray-500">
                {search ? 'No matching items.' : 'No eligible items for this sale.'}
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {availableShown.map(it => (
                  <li key={it.id}>
                    <button
                      onClick={() => addItem(it)}
                      disabled={busy}
                      className="group w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-emerald-50/60 active:bg-emerald-100/60 disabled:opacity-50 transition"
                    >
                      <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${it.type === 'tc' ? 'bg-sky-500' : 'bg-emerald-500'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-medium text-sm text-gray-900 truncate">{it.name || it.sku}</span>
                          {it.variety && <span className="text-xs text-gray-500 truncate">· {it.variety}</span>}
                        </span>
                        <span className="block text-xs text-gray-500 font-mono">{it.sku}</span>
                      </span>
                      <span className="text-sm text-gray-700 w-12 text-right flex-shrink-0">
                        {it.listingPrice ? `$${parseFloat(it.listingPrice).toFixed(0)}` : '—'}
                      </span>
                      <span className="flex items-center gap-1 text-xs font-medium text-emerald-700 flex-shrink-0 opacity-0 group-hover:opacity-100 transition">
                        <Plus className="w-4 h-4" /> Add
                      </span>
                    </button>
                  </li>
                ))}
                {available.length > BROWSE_CAP && (
                  <li className="px-3 py-2.5 text-center text-xs text-gray-500">
                    Showing first {BROWSE_CAP} of {available.length} — type above to narrow.
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>

        {/* Staged for this sale */}
        <div className="bg-white rounded-xl border border-gray-200 flex flex-col">
          <div className="p-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">
              Staged for this sale
              <span className="ml-1.5 text-xs font-normal text-gray-500">({staged.length})</span>
            </h3>
          </div>
          {staged.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <Tag className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">
                Nothing staged yet. Pick items from the list on the left, or scan a SKU above.
              </p>
            </div>
          ) : (
            <div className="p-3 space-y-2 max-h-[480px] overflow-y-auto">
              {staged.map(it => (
                <PreSaleRow
                  key={it.id}
                  item={it}
                  busy={busy}
                  showToast={showToast}
                  onRemove={() => removeFromSale(it)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreSaleRow({ item, busy, showToast, onRemove }) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState(null); // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try { setPhotos(await api.listItemPhotos(item.id)); }
    catch (e) { showToast?.(e.message || 'Could not load photos', 'error'); setPhotos([]); }
    finally { setLoading(false); }
  };

  // Load the count lazily on first expand.
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && photos === null) load();
  };

  const onPick = async (e) => {
    const files = Array.from(e.target.files || []);
    if (e.target) e.target.value = '';
    const images = files.filter(f => f.type?.startsWith('image/'));
    if (!images.length) return;
    setUploading(true);
    try {
      for (const f of images) {
        const fileBase64 = await fileToBase64(f);
        await api.uploadItemPhoto({
          itemId: item.id,
          fileBase64,
          contentType: f.type || 'image/jpeg',
          filename: f.name,
        });
      }
      await load();
    } catch (err) {
      showToast?.(err.message || 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const del = async (id) => {
    try {
      await api.deleteItemPhoto(id);
      setPhotos(p => (p || []).filter(x => x.id !== id));
    } catch (e) {
      showToast?.(e.message || 'Delete failed', 'error');
    }
  };

  const count = photos === null ? null : photos.length;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${item.type === 'tc' ? 'bg-sky-500' : 'bg-emerald-500'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-gray-900 truncate">{item.name || item.sku}</span>
            {item.variety && <span className="text-xs text-gray-500 truncate">· {item.variety}</span>}
          </div>
          <div className="text-xs text-gray-500 font-mono mt-0.5">{item.sku}</div>
        </div>
        <div className="text-sm font-medium text-gray-900 w-12 text-right flex-shrink-0">
          {item.listingPrice ? `$${parseFloat(item.listingPrice).toFixed(0)}` : '—'}
        </div>
        <button
          onClick={toggle}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border flex-shrink-0 transition ${
            count ? 'border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50 active:bg-gray-100'
          }`}
        >
          {count ? <Check className="w-3.5 h-3.5" /> : <ImagePlus className="w-3.5 h-3.5" />}
          Photos{count !== null ? ` (${count})` : ''}
        </button>
        <button
          onClick={onRemove}
          disabled={busy}
          className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 rounded-lg flex-shrink-0 disabled:opacity-50"
          title="Remove from sale"
          aria-label="Remove from sale"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {open && (
        <div className="border-t border-gray-100 px-3 py-3 bg-gray-50/60">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-4 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading photos…
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(photos || []).map(p => (
                <div key={p.id} className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-200 bg-white">
                  {p.signedUrl
                    ? <img src={p.signedUrl} alt="" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-gray-300"><ImagePlus className="w-5 h-5" /></div>}
                  <button
                    onClick={() => del(p.id)}
                    className="absolute top-0.5 right-0.5 p-1 rounded-full bg-white/90 hover:bg-red-50 text-red-600"
                    title="Delete photo"
                    aria-label="Delete photo"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-300 flex flex-col items-center justify-center gap-1 text-gray-400 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-50"
              >
                {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImagePlus className="w-5 h-5" />}
                <span className="text-[10px]">{uploading ? 'Uploading' : 'Add'}</span>
              </button>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPick} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
