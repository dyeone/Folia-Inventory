import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Tag, ScanLine, Search, X, Loader2, ImagePlus, Trash2, Calendar, Plus, Check,
  Download, ChevronRight,
} from 'lucide-react';
import { api } from '../api.js';
import { ImageDropZone } from '../purchasing/ImageDropZone.jsx';
import { exportPalmstreetCsv } from './palmstreetExport.js';

// Pre Sale — stage individual inventory items into an upcoming sale event's
// lineup by SKU (scan or type), fill in their Palmstreet listing details
// (the fields that map 1:1 to Palmstreet's CSV template), attach per-item
// photos (drag/drop/click/paste), and export the whole lineup as a Palmstreet
// CSV. See migration 0019 (item_photos), 0020 (listingDetails) and
// palmstreetExport.js for the column mapping.
//
// Saving prefers the parent's proven item-save handler (onStageItems, same
// partial-patch shape LineupBuilder emits) so item-column invariants are
// respected; without it, it falls back to a direct upsert.

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

function saleSortKey(s) {
  const t = s.startTime ? Date.parse(s.startTime) : (s.date ? Date.parse(s.date) : NaN);
  return Number.isNaN(t) ? Infinity : t;
}

function skuNum(sku) {
  const m = /-(\d+)\s*$/.exec(sku || '');
  return m ? parseInt(m[1], 10) : -1;
}

// Postgres rejects "" for numeric columns, so blanks become null.
function numOrNull(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function PreSaleTab({ sales, items, showToast, onStageItems, onItemsChanged }) {
  const openSales = useMemo(
    () => sales.filter(s => s.status !== 'closed').slice().sort((a, b) => saleSortKey(a) - saleSortKey(b)),
    [sales],
  );

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

  // Apply a partial item patch (staging assignment OR listing-detail edit)
  // through the parent's saveItems, falling back to a direct upsert.
  const patchItem = async (id, patch, optimisticSaleId) => {
    if (optimisticSaleId !== undefined) setOverride(p => ({ ...p, [id]: optimisticSaleId }));
    if (onStageItems) {
      await onStageItems([{ id, ...patch }]);
    } else {
      await api.upsertItems([{ id, ...patch }]);
      onItemsChanged?.();
    }
  };

  const assign = async (it, toSaleId) => {
    setBusy(true);
    try {
      const patch = { saleId: toSaleId, lotKind: 'sale' };
      if (!toSaleId) patch.lotNumber = null;
      await patchItem(it.id, patch, toSaleId);
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

  // Persist a row's listing-detail form. No optimistic saleId change.
  const saveDetails = async (id, patch) => {
    await patchItem(id, patch);
  };

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

  const doExport = () => {
    if (!sale) return;
    const res = exportPalmstreetCsv(sale, items);
    if (!res.ok) { flash('error', res.reason); return; }
    flash('ok', `Exported ${res.count} lots`);
  };

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
      {/* Sale picker + scanner + export */}
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
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2.5">
              <span className="text-sm text-emerald-800">
                <span className="font-semibold">{staged.length}</span> staged
              </span>
              <span className="text-emerald-300">·</span>
              <span className="text-sm font-semibold text-emerald-700">${stagedValue.toFixed(0)}</span>
            </div>
            <button
              onClick={doExport}
              disabled={!staged.length}
              title="Download this lineup as a Palmstreet CSV"
              className="flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white disabled:bg-gray-200 disabled:text-gray-400"
            >
              <Download className="w-4 h-4" /> Export CSV
            </button>
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

          <div className="max-h-[520px] overflow-y-auto">
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
            <div className="p-3 space-y-2 max-h-[640px] overflow-y-auto">
              {staged.map(it => (
                <PreSaleRow
                  key={it.id}
                  item={it}
                  busy={busy}
                  showToast={showToast}
                  onRemove={() => removeFromSale(it)}
                  onSaveDetails={(patch) => saveDetails(it.id, patch)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Default Palmstreet title for an item with no override: "<name> <variety>".
function defaultTitle(item) {
  let t = item.name || '';
  if (item.variety) t = `${t} ${item.variety}`.trim();
  return t.slice(0, 80);
}

function PreSaleRow({ item, busy, showToast, onRemove, onSaveDetails }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Listing-detail form, seeded from the item's columns + listingDetails blob.
  const d = (item.listingDetails && typeof item.listingDetails === 'object') ? item.listingDetails : {};
  const vars = Array.isArray(d.variations) ? d.variations : [];
  const [form, setForm] = useState({
    title: d.title ?? '',
    description: d.description ?? '',
    imageUrl: item.imageUrl ?? '',
    price: item.listingPrice ?? '',
    quantity: item.quantity ?? 1,
    v: [0, 1, 2].map(i => ({ name: vars[i]?.name ?? '', value: vars[i]?.value ?? '' })),
    private: !!d.private,
    shipping: d.shipping ?? '',
  });
  const setField = (k, val) => setForm(f => ({ ...f, [k]: val }));
  const setVar = (i, k, val) => setForm(f => ({ ...f, v: f.v.map((x, j) => j === i ? { ...x, [k]: val } : x) }));

  const hasDetails = !!(form.title || form.description || form.v.some(x => x.name || x.value) || form.shipping || form.private);

  // Photos
  const [photos, setPhotos] = useState(null);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [uploading, setUploading] = useState(false);

  const loadPhotos = async () => {
    setLoadingPhotos(true);
    try { setPhotos(await api.listItemPhotos(item.id)); }
    catch (e) { showToast?.(e.message || 'Could not load photos', 'error'); setPhotos([]); }
    finally { setLoadingPhotos(false); }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && photos === null) loadPhotos();
  };

  const uploadFile = async (file) => {
    if (!file?.type?.startsWith('image/')) return;
    setUploading(true);
    try {
      const fileBase64 = await fileToBase64(file);
      await api.uploadItemPhoto({
        itemId: item.id,
        fileBase64,
        contentType: file.type || 'image/jpeg',
        filename: file.name,
      });
      await loadPhotos();
    } catch (err) {
      showToast?.(err.message || 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

  const delPhoto = async (id) => {
    try {
      await api.deleteItemPhoto(id);
      setPhotos(p => (p || []).filter(x => x.id !== id));
    } catch (e) {
      showToast?.(e.message || 'Delete failed', 'error');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSaveDetails({
        listingPrice: numOrNull(form.price),
        quantity: parseInt(form.quantity, 10) || 1,
        imageUrl: form.imageUrl?.trim() || null,
        listingDetails: {
          title: form.title?.trim() || '',
          description: form.description?.trim() || '',
          variations: form.v.map(x => ({ name: x.name.trim(), value: x.value.trim() })),
          private: !!form.private,
          shipping: form.shipping?.trim() || '',
        },
      });
      showToast?.('Details saved');
    } catch (e) {
      showToast?.(e.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const photoCount = photos === null ? null : photos.length;
  const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white';

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button onClick={toggle} className="flex items-center gap-2.5 min-w-0 flex-1 text-left" aria-expanded={open}>
          <ChevronRight className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${item.type === 'tc' ? 'bg-sky-500' : 'bg-emerald-500'}`} />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="font-medium text-sm text-gray-900 truncate">{form.title || item.name || item.sku}</span>
              {item.variety && <span className="text-xs text-gray-500 truncate">· {item.variety}</span>}
            </span>
            <span className="block text-xs text-gray-500 font-mono">{item.sku}</span>
          </span>
        </button>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {hasDetails && <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded"><Check className="w-3 h-3" /> details</span>}
          {photoCount ? <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded"><ImagePlus className="w-3 h-3" /> {photoCount}</span> : null}
          <span className="text-sm font-medium text-gray-900 w-12 text-right">
            {form.price !== '' && form.price != null ? `$${parseFloat(form.price).toFixed(0)}` : '—'}
          </span>
          <button
            onClick={onRemove}
            disabled={busy}
            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 rounded-lg disabled:opacity-50"
            title="Remove from sale"
            aria-label="Remove from sale"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-gray-100 px-3 py-3 bg-gray-50/60 space-y-3">
          {/* Palmstreet listing fields */}
          <div className="space-y-2.5">
            <label className="block">
              <span className="text-[11px] font-medium text-gray-600">Title <span className="text-gray-400">(80 char max)</span></span>
              <input
                type="text" maxLength={80} value={form.title}
                onChange={(e) => setField('title', e.target.value)}
                placeholder={defaultTitle(item) || 'Listing title'}
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-gray-600">Description</span>
              <textarea
                rows={3} value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                placeholder="Item description for the Palmstreet listing"
                className={`${inputCls} resize-none`}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-gray-600">Image URL <span className="text-gray-400">(public, for the CSV)</span></span>
              <input
                type="url" value={form.imageUrl}
                onChange={(e) => setField('imageUrl', e.target.value)}
                placeholder="https://…"
                className={inputCls}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] font-medium text-gray-600">Price</span>
                <input
                  type="number" step="0.01" inputMode="decimal" value={form.price}
                  onChange={(e) => setField('price', e.target.value)}
                  placeholder="0.00" className={inputCls}
                />
              </label>
              <label className="block">
                <span className="text-[11px] font-medium text-gray-600">Quantity</span>
                <input
                  type="number" min="1" inputMode="numeric" value={form.quantity}
                  onChange={(e) => setField('quantity', e.target.value)}
                  className={inputCls}
                />
              </label>
            </div>

            <div>
              <span className="text-[11px] font-medium text-gray-600">Variations <span className="text-gray-400">(optional, up to 3)</span></span>
              <div className="mt-1 space-y-1.5">
                {form.v.map((x, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2">
                    <input
                      type="text" value={x.name}
                      onChange={(e) => setVar(i, 'name', e.target.value)}
                      placeholder={`Variation ${i + 1} name`} className={inputCls}
                    />
                    <input
                      type="text" value={x.value}
                      onChange={(e) => setVar(i, 'value', e.target.value)}
                      placeholder={`Variation ${i + 1} value`} className={inputCls}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              <label className="block flex-1">
                <span className="text-[11px] font-medium text-gray-600">Shipping <span className="text-gray-400">(blank = store setting)</span></span>
                <input
                  type="text" value={form.shipping}
                  onChange={(e) => setField('shipping', e.target.value)}
                  placeholder="e.g. Free, or a flat amount" className={inputCls}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 py-1.5 sm:pb-2.5">
                <input
                  type="checkbox" checked={form.private}
                  onChange={(e) => setField('private', e.target.checked)}
                  className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
                />
                Private listing
              </label>
            </div>
          </div>

          {/* Photos — drag, drop, click, or paste */}
          <div>
            <span className="text-[11px] font-medium text-gray-600">Photos</span>
            <div className="mt-1 space-y-2">
              {loadingPhotos ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 py-3 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading photos…
                </div>
              ) : (
                <>
                  {(photos || []).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {photos.map(p => (
                        <div key={p.id} className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-200 bg-white">
                          {p.signedUrl
                            ? <img src={p.signedUrl} alt="" className="w-full h-full object-cover" />
                            : <div className="w-full h-full flex items-center justify-center text-gray-300"><ImagePlus className="w-5 h-5" /></div>}
                          <button
                            onClick={() => delPhoto(p.id)}
                            className="absolute top-0.5 right-0.5 p-1 rounded-full bg-white/90 hover:bg-red-50 text-red-600"
                            title="Delete photo" aria-label="Delete photo"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <ImageDropZone onFile={uploadFile} multiple disabled={uploading}>
                    <div className="p-4 text-center text-xs text-gray-500 space-y-1">
                      {uploading
                        ? <Loader2 className="w-5 h-5 mx-auto text-emerald-600 animate-spin" />
                        : <ImagePlus className="w-5 h-5 mx-auto text-gray-400" />}
                      <div>{uploading ? 'Uploading…' : 'Drag & drop, click, or paste a photo'}</div>
                    </div>
                  </ImageDropZone>
                </>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg disabled:opacity-60"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Save details
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
