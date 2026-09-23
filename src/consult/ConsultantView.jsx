import { useContext, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LogOut, ClipboardList, Check, Loader2, Search, ChevronRight, Tag } from 'lucide-react';
import { api } from '../api.js';
import { AuthContext } from '../AuthContext.js';

// Consultant screen — a mobile-only pricing pass over the wholesale orders.
//
// The consultant role (migration 0045) exists to do one job: look at each
// wholesale order and, per line, set the species LIST price and the note
// for the seller — the same two species fields the streamer sees on scan
// (list price as the recommendation, note as "Say this"). They get this
// screen and nothing else: no inventory, sales, packing, or costs (the
// purchase-orders API strips costs for non-admins; the species API strips
// wholesalePrice for this role). Phone-first layout, centered and capped on
// a desktop so it still reads as the same screen.
//
// Both fields live on the SPECIES, so a price set here shows on every order
// of that plant and on the live surfaces immediately.

const STATUS_ORDER = { ordered: 0, draft: 1, received: 2 };
const STATUS_LABEL = { draft: 'Draft', ordered: 'Ordered', received: 'Received' };
const STATUS_CLASS = {
  draft: 'bg-gray-100 text-gray-700',
  ordered: 'bg-amber-100 text-amber-800',
  received: 'bg-emerald-100 text-emerald-800',
};
const fmtDate = (t) => (t ? String(t).slice(0, 10) : '');
const money = (v) => (v == null || v === '' ? null : parseFloat(v));
const fmtInt = (v) => (v == null ? '—' : Number(v).toLocaleString());
const fmtMoney = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);

export function ConsultantView({ onLogout }) {
  const { currentUser, activeBrand, brands, switchBrand } = useContext(AuthContext);
  const [pos, setPos] = useState(null);
  const [species, setSpecies] = useState([]);
  const [stats, setStats] = useState(null);       // { totals, bySpecies } — stock + sales, no costs
  const [err, setErr] = useState(null);
  const [openPo, setOpenPo] = useState(null);
  const [lines, setLines] = useState(null);
  const [toast, setToast] = useState(null);

  const speciesById = useMemo(() => new Map((species || []).map(s => [s.id, s])), [species]);

  const showToast = (msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  };

  // Orders + catalog. Ordered first (that's the pricing work), then drafts,
  // then received — newest first inside each. Loads once per mount: App
  // remounts this screen (keyed on the brand) when the brand switches, so
  // there's no stale state to reset here.
  useEffect(() => {
    let alive = true;
    Promise.all([api.listPurchaseOrders('ordered,draft,received'), api.getSpecies()])
      .then(([ps, sp]) => {
        if (!alive) return;
        const sorted = [...(ps || [])].sort((a, b) =>
          (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
          || new Date(b.createdAt) - new Date(a.createdAt));
        setPos(sorted);
        setSpecies(sp || []);
      })
      .catch(e => { if (alive) setErr(e.message || 'Could not load orders'); });
    // Stock + sales context arrives separately — pricing must not wait on it.
    api.getSpeciesStats().then(st => { if (alive) setStats(st || null); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const open = async (po) => {
    setOpenPo(po);
    setLines(null);
    try {
      const r = await api.getPurchaseOrder(po.id);
      setLines([...(r.lines || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    } catch (e) {
      showToast(e.message || 'Could not load the order', 'error');
      setOpenPo(null);
    }
  };

  const onSpeciesSaved = (id, patch) => {
    setSpecies(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <TopBar
        title={openPo ? (openPo.supplier || 'Wholesale order') : 'Pricing'}
        subtitle={openPo ? `${STATUS_LABEL[openPo.status] || openPo.status} · ${fmtDate(openPo.createdAt)}` : currentUser.displayName}
        onBack={openPo ? () => { setOpenPo(null); setLines(null); } : null}
        onLogout={onLogout}
      />
      {!openPo && brands && brands.length > 1 && (
        <BrandStrip brands={brands} activeBrand={activeBrand} onSwitch={switchBrand} />
      )}

      <div className="flex-1 w-full max-w-md mx-auto px-3 py-3 pb-24">
        {err ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{err}</div>
        ) : !pos ? (
          <div className="py-16 text-center text-gray-500"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading orders…</div>
        ) : openPo ? (
          <OrderDetail
            po={openPo}
            lines={lines}
            speciesById={speciesById}
            statsBySpecies={stats?.bySpecies || null}
            onSpeciesSaved={onSpeciesSaved}
            showToast={showToast}
          />
        ) : pos.length === 0 ? (
          <div className="py-16 text-center text-gray-500 text-sm">No wholesale orders for this brand yet.</div>
        ) : (
          <div className="space-y-2">
            <InventorySummary totals={stats?.totals || null} loaded={!!stats} />
            <div className="text-xs text-gray-500 px-1 pt-1">Tap an order to set list prices and seller notes.</div>
            {pos.map(po => (
              <button
                key={po.id}
                type="button"
                onClick={() => open(po)}
                className="w-full text-left bg-white rounded-2xl border border-gray-200 px-4 py-3.5 flex items-center gap-3 active:bg-gray-50"
              >
                <div className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center flex-shrink-0">
                  <ClipboardList className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-900 truncate">{po.supplier || 'Wholesale order'}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {fmtDate(po.createdAt)} · {po.lineCount} {po.lineCount === 1 ? 'plant' : 'plants'} · {po.unitCount} {po.unitCount === 1 ? 'unit' : 'units'}
                  </div>
                </div>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_CLASS[po.status] || 'bg-gray-100 text-gray-700'}`}>
                  {STATUS_LABEL[po.status] || po.status}
                </span>
                <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {toast && (
        <div className={`fixed left-1/2 -translate-x-1/2 bottom-6 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg ${
          toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// Brand-wide stock + sales, on the order list. Sale prices are the
// consultant's pricing context; costs never reach this screen.
function InventorySummary({ totals, loaded }) {
  const t = totals || {};
  const tile = (label, value, sub) => (
    <div className="bg-gray-50 rounded-xl px-3 py-2 min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 truncate">{label}</div>
      <div className="text-lg font-bold text-gray-900 tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-gray-500 truncate">{sub}</div>}
    </div>
  );
  return (
    <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-gray-900">Inventory &amp; sales</div>
        <div className="text-[11px] text-gray-500">{loaded ? 'last 30 days' : 'loading…'}</div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tile('In stock', loaded ? fmtInt(t.inStock) : '—', 'units on hand')}
        {tile('Sold', loaded ? fmtInt(t.sold30d) : '—', loaded ? `${fmtInt(t.sold)} all time` : null)}
        {tile('Avg sale', loaded ? fmtMoney(t.avgSalePrice30d) : '—', loaded && t.avgSalePrice != null ? `${fmtMoney(t.avgSalePrice)} all time` : null)}
      </div>
    </div>
  );
}

// Per-plant stock + sales line under the quantities on a line card.
function SpeciesStats({ st }) {
  if (!st) return null;
  if (!st.sold && !st.inStock) return <div className="text-xs text-gray-400 mt-1">No stock or sales history yet</div>;
  return (
    <div className="text-xs text-gray-600 mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
      <span>In stock <b className="text-gray-900">{fmtInt(st.inStock)}</b></span>
      <span>·</span>
      {st.sold ? (
        <>
          <span>Sold <b className="text-gray-900">{fmtInt(st.sold)}</b>{st.sold30d ? ` (${fmtInt(st.sold30d)} in 30d)` : ''}</span>
          {st.avgSalePrice != null && <><span>·</span><span>Avg <b className="text-gray-900">{fmtMoney(st.avgSalePrice)}</b></span></>}
          {st.lastSalePrice != null && <><span>·</span><span>Last <b className="text-gray-900">{fmtMoney(st.lastSalePrice)}</b>{st.lastSoldAt ? ` on ${fmtDate(st.lastSoldAt)}` : ''}</span></>}
        </>
      ) : <span>No sales yet</span>}
    </div>
  );
}

function OrderDetail({ po, lines, speciesById, statsBySpecies, onSpeciesSaved, showToast }) {
  const [q, setQ] = useState('');
  if (!lines) {
    return <div className="py-16 text-center text-gray-500"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading plants…</div>;
  }
  const rows = lines.map(l => ({ line: l, sp: speciesById.get(l.speciesId) || null }));
  const priced = rows.filter(r => money(r.sp?.idealSellingPrice) > 0).length;
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter(r => `${r.sp?.epithet || ''} ${r.sp?.commonName || ''} ${r.sp?.varietyName || ''}`.toLowerCase().includes(needle))
    : rows;
  return (
    <div>
      <div className="sticky top-0 z-10 -mx-3 px-3 pt-1 pb-2 bg-gray-100">
        <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <Tag className="w-5 h-5 text-emerald-700 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-gray-900">{priced} of {rows.length} priced</div>
            <div className="text-xs text-gray-500">{po.notes ? po.notes : 'List price + note for the seller, per plant'}</div>
          </div>
          <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-700 font-bold tabular-nums text-sm">
            {rows.length ? Math.round((priced / rows.length) * 100) : 0}%
          </div>
        </div>
        {rows.length > 6 && (
          <label className="mt-2 flex items-center gap-2 bg-white rounded-xl border border-gray-200 px-3">
            <Search className="w-4 h-4 text-gray-400" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a plant…"
              className="flex-1 h-11 text-base outline-none bg-transparent"
            />
          </label>
        )}
      </div>
      <div className="space-y-3 mt-2">
        {shown.length === 0 && <div className="py-10 text-center text-gray-500 text-sm">No plants match.</div>}
        {shown.map(({ line, sp }) => (
          <LineCard key={line.id} line={line} species={sp} stats={statsBySpecies ? (statsBySpecies[line.speciesId] || null) : undefined} onSaved={onSpeciesSaved} showToast={showToast} />
        ))}
      </div>
    </div>
  );
}

// One plant: photo, name, quantities, then the two fields the consultant
// owns. Each saves on blur (or Enter for the price) so a phone keyboard's
// "Done" is the whole gesture; a check mark confirms the save landed.
function LineCard({ line, species, stats, onSaved, showToast }) {
  const [price, setPrice] = useState(species?.idealSellingPrice != null ? String(species.idealSellingPrice) : '');
  const [note, setNote] = useState(species?.sellNote || '');
  const [saving, setSaving] = useState(null);      // 'price' | 'note' | null
  const [savedTick, setSavedTick] = useState(null); // which field just saved
  const [photoUrl, setPhotoUrl] = useState(null);

  const primaryPhotoId = (() => {
    const photos = species?.photos || [];
    if (!photos.length) return null;
    if (species?.primaryPhotoId && photos.find(p => p.id === species.primaryPhotoId)) return species.primaryPhotoId;
    return photos[0]?.id || null;
  })();
  useEffect(() => {
    if (!primaryPhotoId) return undefined;
    let alive = true;
    api.speciesPhotoSignedUrl(primaryPhotoId).then(u => { if (alive) setPhotoUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [primaryPhotoId]);
  const imgUrl = primaryPhotoId ? photoUrl : (species?.imageUrl || null);

  const flash = (field) => { setSavedTick(field); setTimeout(() => setSavedTick(null), 1800); };

  const savePrice = async () => {
    if (!species) return;
    const raw = price.trim();
    const v = raw === '' ? null : parseFloat(raw);
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      setPrice(species.idealSellingPrice != null ? String(species.idealSellingPrice) : '');
      return;
    }
    const cur = money(species.idealSellingPrice);
    if ((v === null && cur === null) || (v !== null && cur !== null && v === cur)) return;
    setSaving('price');
    try {
      const r = await api.updateSpecies({ id: species.id, patch: { idealSellingPrice: v } });
      onSaved(species.id, { idealSellingPrice: v });
      const n = r?.restamped?.listing || 0;
      showToast(v === null ? 'List price cleared' : `List price $${v.toFixed(2)} saved${n ? ` · ${n} plant${n === 1 ? '' : 's'} repriced` : ''}`);
      flash('price');
    } catch (e) {
      showToast(e.message || 'Could not save the price', 'error');
      setPrice(cur != null ? String(cur) : '');
    } finally { setSaving(null); }
  };

  const saveNote = async () => {
    if (!species) return;
    const v = note.trim();
    if (v === (species.sellNote || '')) return;
    setSaving('note');
    try {
      const r = await api.updateSpecies({ id: species.id, patch: { sellNote: v || null } });
      if (r?.sellNoteUnsupported) {
        showToast('Notes need a database update — tell the admin (migration 0044)', 'error');
        setNote(species.sellNote || '');
        return;
      }
      onSaved(species.id, { sellNote: v || null });
      showToast(v ? 'Note saved' : 'Note cleared');
      flash('note');
    } catch (e) {
      showToast(e.message || 'Could not save the note', 'error');
      setNote(species.sellNote || '');
    } finally { setSaving(null); }
  };

  const name = species ? [species.varietyName, species.epithet].filter(Boolean).join(' · ') : '(unknown plant)';
  const hasPrice = money(species?.idealSellingPrice) > 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-3.5">
      <div className="flex items-start gap-3">
        <div className="w-16 h-16 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center text-gray-300">
          {imgUrl ? <img src={imgUrl} alt="" className="w-full h-full object-cover" /> : <Tag className="w-5 h-5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 leading-snug">{species?.epithet || '(unknown plant)'}</div>
          {species?.varietyName && <div className="text-sm text-gray-500">{species.varietyName}</div>}
          {species?.commonName && <div className="text-xs text-gray-400">{species.commonName}</div>}
          <div className="text-xs text-gray-500 mt-1">
            {line.quantityOrdered} ordered
            {line.quantityReceived > 0 ? ` · ${line.quantityReceived} received` : ''}
            {(line.itemType === 'tc') ? ' · TC' : ''}
          </div>
          {stats !== undefined && <SpeciesStats st={stats || { inStock: 0, sold: 0 }} />}
        </div>
        {hasPrice && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex-shrink-0">priced</span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 items-center">
        <label htmlFor={`price-${line.id}`} className="text-sm font-medium text-gray-700">List price</label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-lg">$</span>
          <input
            id={`price-${line.id}`}
            type="number"
            inputMode="decimal"
            enterKeyHint="done"
            step="0.01"
            min={0}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            onBlur={savePrice}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            disabled={!species || saving === 'price'}
            placeholder="0.00"
            aria-label={`List price for ${name}`}
            className="w-full h-12 pl-8 pr-10 text-lg font-semibold tabular-nums border-2 border-emerald-300 bg-emerald-50/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:opacity-60"
          />
          <FieldState saving={saving === 'price'} saved={savedTick === 'price'} />
        </div>

        <label htmlFor={`note-${line.id}`} className="text-sm font-medium text-gray-700 self-start pt-2">Note for<br />the seller</label>
        <div className="relative">
          <textarea
            id={`note-${line.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            disabled={!species || saving === 'note'}
            rows={2}
            maxLength={1000}
            placeholder="What to say about this plant on the live…"
            aria-label={`Note for the seller about ${name}`}
            className="w-full px-3 py-2 pr-10 text-base border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 resize-y disabled:opacity-60"
          />
          <FieldState saving={saving === 'note'} saved={savedTick === 'note'} />
        </div>
      </div>
    </div>
  );
}

function FieldState({ saving, saved }) {
  if (!saving && !saved) return null;
  return (
    <span className="absolute right-3 top-3 text-emerald-600" aria-live="polite">
      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
    </span>
  );
}

function TopBar({ title, subtitle, onBack, onLogout }) {
  return (
    <div className="bg-emerald-700 text-white pt-safe flex-shrink-0">
      <div className="h-16 px-3 flex items-center gap-2 max-w-md mx-auto">
        {onBack ? (
          <button onClick={onBack} aria-label="Back" className="w-12 h-12 -ml-2 rounded-full flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900">
            <ArrowLeft className="w-6 h-6" />
          </button>
        ) : (
          <div className="w-12 h-12 -ml-2 rounded-full flex items-center justify-center"><Tag className="w-6 h-6" /></div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-lg leading-tight truncate">{title}</div>
          {subtitle && <div className="text-sm text-emerald-100 leading-tight truncate mt-0.5">{subtitle}</div>}
        </div>
        <button onClick={onLogout} aria-label="Log out" className="w-12 h-12 -mr-2 rounded-full flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900">
          <LogOut className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}

function BrandStrip({ brands, activeBrand, onSwitch }) {
  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-3 py-2.5">
      <div className="max-w-md mx-auto flex items-center gap-2">
        {brands.map((b) => {
          const active = b.id === activeBrand;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => { if (!active) onSwitch(b.id); }}
              aria-pressed={active}
              className={`flex-1 h-11 rounded-xl border-2 text-sm font-semibold inline-flex items-center justify-center gap-2 ${active ? 'text-white' : 'bg-white text-gray-600 border-gray-200'}`}
              style={active ? { background: b.accent, borderColor: b.accent } : undefined}
            >
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: active ? '#fff' : b.accent }} />
              {b.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
