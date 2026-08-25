import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Trash2, Check, Truck, Upload, Plus, ArrowLeftRight } from 'lucide-react';
import { api } from '../api.js';
import { BRANDS, DEFAULT_BRAND, brandName } from '../brands.js';
import { PurchaseOrderLineRow } from './PurchaseOrderLineRow.jsx';
import { NameAutocomplete } from './NameAutocomplete.jsx';
import { UpdateOrderModal } from './UpdateOrderModal.jsx';

const STATUS_CLASS = {
  draft:    'bg-gray-300',
  ordered:  'bg-amber-500',
  received: 'bg-emerald-500',
};

export function PurchaseOrderCard({ po, species, varieties, speciesById, isAdmin, showToast, onChanged, onSpeciesChanged, setConfirmDialog }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState(null);
  const [receivedItems, setReceivedItems] = useState([]);
  // Initial true so the first expand shows the spinner; the async IIFE
  // below flips it false in finally().
  const [loading, setLoading] = useState(true);
  const [savingHeader, setSavingHeader] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);

  // Local header state — initialized once from props. Edits stick until
  // saved-or-discarded; subsequent prop changes (e.g., parent refresh)
  // don't blow away mid-typed input. After save, onChanged() bubbles up
  // and the parent reloads the list — the new prop will match local state.
  const [supplier,    setSupplier]    = useState(po.supplier || '');
  // The server strips shippingFee for non-admin viewers — absent means
  // "hidden from you", not zero, so blur must never flush a 0 back.
  const hasFee = po.shippingFee != null;
  const [shippingFee, setShippingFee] = useState(hasFee ? String(po.shippingFee) : '');
  const [notes,       setNotes]       = useState(po.notes || '');
  // Item settings (0038) mirror the siblings' seeded-local-state pattern:
  // the select shows the picked value immediately (no snap-back while the
  // save round-trips), and absent columns (un-migrated DB) read as defaults.
  const [itemType,   setItemType]   = useState(po.itemType || 'plant');
  const [itemStatus, setItemStatus] = useState((po.itemType === 'tc' && po.itemStatus) || 'available');
  const [itemNotes,  setItemNotes]  = useState(po.itemNotes || '');

  // Fetch lines on first expand. Uses async IIFE so setState only fires
  // via await resolution (satisfies the react-hooks/set-state-in-effect rule).
  useEffect(() => {
    if (!open || lines !== null) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { lines: ls, receivedItems: ri } = await api.getPurchaseOrder(po.id);
        if (cancelled) return;
        setLines(ls);
        setReceivedItems(ri || []);
      } catch (e) {
        if (!cancelled) showToast?.(e.message || 'Load failed', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, lines, po.id, showToast]);

  const refreshLines = async () => {
    try {
      const { lines: ls, receivedItems: ri } = await api.getPurchaseOrder(po.id);
      setLines(ls);
      setReceivedItems(ri || []);
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Load failed', 'error');
    }
  };

  const flushHeader = async (patch) => {
    setSavingHeader(true);
    try {
      await api.updatePurchaseOrderHeader({ id: po.id, ...patch });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Save failed', 'error');
    } finally {
      setSavingHeader(false);
    }
  };

  const markOrdered = async () => {
    try {
      await api.markPurchaseOrderOrdered(po.id);
      await refreshLines();
      showToast?.('Marked as ordered');
    } catch (e) {
      showToast?.(e.message || 'Failed', 'error');
    }
  };

  const markAllReceived = async () => {
    if (!lines) return;
    const targets = lines.filter(l => l.quantityReceived < l.quantityOrdered);
    if (targets.length === 0) {
      showToast?.('Already fully received');
      return;
    }
    try {
      for (const l of targets) {
        await api.receivePurchaseOrderLine({
          id: po.id,
          lineId: l.id,
          quantityReceived: l.quantityOrdered - l.quantityReceived,
        });
      }
      await refreshLines();
      showToast?.('Marked all received');
    } catch (e) {
      showToast?.(e.message || 'Receive failed', 'error');
      await refreshLines();
    }
  };

  const deletePo = () => {
    setConfirmDialog?.({
      title: 'Delete this draft?',
      message: 'This removes the PO and all its lines. Cannot be undone (it goes through the 30-day soft-delete pattern).',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deletePurchaseOrder(po.id);
          showToast?.('Deleted');
          onChanged?.();
        } catch (e) {
          showToast?.(e.message || 'Delete failed', 'error');
        }
      },
    });
  };

  const isDraft = po.status === 'draft';

  // Species rows carry only varietyId — look up the NAME so a line reads
  // "Monstera · Thai Con" instead of a dangling "· Thai Con".
  const varietyNameById = useMemo(
    () => new Map((varieties || []).map(v => [v.id, v.name])),
    [varieties],
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50"
      >
        <div className="mt-0.5 text-gray-400">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block w-2 h-2 rounded-full ${STATUS_CLASS[po.status] || 'bg-gray-300'}`} />
            <span className="font-medium text-gray-900 capitalize">{po.status}</span>
            <span className="text-gray-500">·</span>
            <span className="text-gray-700">{new Date(po.createdAt).toISOString().slice(0, 10)}</span>
            {po.supplier && (
              <>
                <span className="text-gray-500">·</span>
                <span className="text-gray-700 truncate">{po.supplier}</span>
              </>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {po.lineCount} {po.lineCount === 1 ? 'line' : 'lines'}
            {' · '}
            {po.unitCount} {po.unitCount === 1 ? 'unit' : 'units'}
            {po.shippingFee > 0 && ` + $${parseFloat(po.shippingFee).toFixed(2)} ship`}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          {/* Header editors */}
          <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-3 bg-gray-50/60">
            <Field label="Supplier">
              <input
                type="text"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                onBlur={() => supplier !== (po.supplier || '') && flushHeader({ supplier })}
                disabled={po.status === 'received' || savingHeader}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
            <Field label="Shipping ($)">
              <input
                type="number"
                step="0.01"
                value={shippingFee}
                onChange={(e) => setShippingFee(e.target.value)}
                onBlur={() => hasFee && parseFloat(shippingFee) !== Number(po.shippingFee) && flushHeader({ shippingFee: parseFloat(shippingFee) || 0 })}
                disabled={po.status === 'received' || savingHeader || !hasFee}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
            {/* Item settings (0038) — stamped on every item this order
                mints at receive time. Editable while draft/ordered like the
                other header fields; absent values (un-migrated DB) read as
                the defaults. */}
            <Field label="Items arrive as">
              <select
                value={itemType}
                onChange={(e) => {
                  const t = e.target.value;
                  setItemType(t);
                  if (t !== 'tc') setItemStatus('available');
                  flushHeader({ itemType: t, ...(t !== 'tc' ? { itemStatus: 'available' } : {}) });
                }}
                disabled={po.status === 'received' || savingHeader}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              >
                <option value="plant">Plant</option>
                <option value="tc">TC (Tissue Culture)</option>
              </select>
            </Field>
            <Field label="Initial status">
              <select
                value={itemStatus}
                onChange={(e) => { setItemStatus(e.target.value); flushHeader({ itemStatus: e.target.value }); }}
                disabled={po.status === 'received' || savingHeader || itemType !== 'tc'}
                title={itemType !== 'tc' ? 'Acclimated only applies to TC' : undefined}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              >
                <option value="available">Available</option>
                {itemType === 'tc' && <option value="acclimated">Acclimated</option>}
              </select>
            </Field>
            <Field label="Item note (on every plant)">
              <input
                type="text"
                value={itemNotes}
                onChange={(e) => setItemNotes(e.target.value)}
                onBlur={() => (itemNotes.trim() || '') !== (po.itemNotes || '') && flushHeader({ itemNotes: itemNotes.trim() })}
                disabled={po.status === 'received' || savingHeader}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
            <Field label="Notes">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => notes !== (po.notes || '') && flushHeader({ notes })}
                disabled={po.status === 'received' || savingHeader}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
          </div>

          {/* Lines */}
          {loading ? (
            <div className="p-6 text-center text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading lines…
            </div>
          ) : !lines || lines.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              No lines yet. Add plants {isAdmin ? 'below or ' : ''}from the Catalog tab.
            </div>
          ) : (
            <div>
              {lines.map(line => {
                const sp = speciesById?.get(line.speciesId);
                return (
                <PurchaseOrderLineRow
                  key={line.id}
                  line={line}
                  species={sp ? { ...sp, varietyName: sp.varietyName || varietyNameById.get(sp.varietyId) || '' } : sp}
                  varieties={varieties}
                  receivedItemIds={receivedItems.filter(r => r.lineId === line.id).map(r => r.inventoryItemId)}
                  poStatus={po.status}
                  poId={po.id}
                  poItemType={po.itemType || 'plant'}
                  isAdmin={isAdmin}
                  showToast={showToast}
                  onChanged={refreshLines}
                  onSpeciesChanged={onSpeciesChanged}
                />
                );
              })}
            </div>
          )}

          {/* Manual add — the list stays editable after ordering (suppliers
              revise orders); the new line joins the receiving screen. */}
          {isAdmin && !loading && (isDraft || po.status === 'ordered') && (
            <AddLineRow
              poId={po.id}
              species={species}
              showToast={showToast}
              onAdded={refreshLines}
            />
          )}

          {/* Footer actions */}
          {(isDraft || po.status === 'ordered') && lines && (
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
              {isAdmin && (
                <div className="mr-auto flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setUpdateOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm border border-emerald-600 text-emerald-700 rounded-lg hover:bg-emerald-50"
                    title="Upload the supplier's revised list and sync this order to it"
                  >
                    <Upload className="w-4 h-4" /> Update from list
                  </button>
                  <MigrateControl
                    po={po}
                    lines={lines}
                    showToast={showToast}
                    onChanged={onChanged}
                    setConfirmDialog={setConfirmDialog}
                  />
                </div>
              )}
              {isDraft && (
                <>
                  <button
                    type="button"
                    onClick={deletePo}
                    disabled={savingHeader}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm border border-red-200 text-red-700 rounded-lg hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4" /> Delete PO
                  </button>
                  <button
                    type="button"
                    onClick={markOrdered}
                    disabled={lines.length === 0}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-60"
                  >
                    <Check className="w-4 h-4" /> Mark ordered
                  </button>
                </>
              )}
              {po.status === 'ordered' && (
                <button
                  type="button"
                  onClick={markAllReceived}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg"
                >
                  <Truck className="w-4 h-4" /> Mark all received
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {updateOpen && (
        <UpdateOrderModal
          po={po}
          species={species}
          varieties={varieties}
          showToast={showToast}
          onClose={() => setUpdateOpen(false)}
          onUpdated={refreshLines}
          onSpeciesChanged={onSpeciesChanged}
        />
      )}
    </div>
  );
}

// "Migrate between systems": move this PO into another brand. Admin-only
// (the footer only renders it for admins; migrate-brand is admin server-side
// too). Targets come from the BRANDS map minus the active brand — read off
// <html data-brand> like the label builders, so a rescue session working an
// archived brand still sees every live brand as a destination. The server
// re-maps each line's species into the target brand (creating missing
// species/varieties) and refuses once any units were received, since
// receiving mints inventory under this brand's SKUs.
function MigrateControl({ po, lines, showToast, onChanged, setConfirmDialog }) {
  const activeBrand = document.documentElement.getAttribute('data-brand') || DEFAULT_BRAND;
  const targets = Object.keys(BRANDS).filter(b => b !== activeBrand);
  const [target, setTarget] = useState(targets[0] || '');
  const [busy, setBusy] = useState(false);
  if (!targets.length) return null;

  const hasReceived = (lines || []).some(l => l.quantityReceived > 0);
  const lineCount = lines?.length ?? po.lineCount ?? 0;

  const start = () => {
    setConfirmDialog?.({
      title: `Migrate to ${brandName(target)}?`,
      message: `Moves this PO and its ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} out of ${brandName(activeBrand)} into ${brandName(target)}. Species or varieties it needs are created there automatically; items received later will mint under ${brandName(target)}'s SKUs. It will disappear from this list and show up in ${brandName(target)}'s Orders.`,
      confirmLabel: 'Migrate',
      onConfirm: async () => {
        setBusy(true);
        try {
          const r = await api.migratePurchaseOrderBrand({ id: po.id, targetBrandId: target });
          const created = r?.migrated?.createdSpecies;
          showToast?.(`Migrated to ${brandName(target)}${created ? ` · ${created} species created` : ''}`);
          onChanged?.();
        } catch (e) {
          showToast?.(e.message || 'Migrate failed', 'error');
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <div className="flex items-center gap-1.5">
      {targets.length > 1 && (
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="px-2 py-2 text-sm border border-gray-300 rounded-lg"
          title="Destination brand"
        >
          {targets.map(b => <option key={b} value={b}>{brandName(b)}</option>)}
        </select>
      )}
      <button
        type="button"
        onClick={start}
        disabled={busy || hasReceived}
        title={hasReceived
          ? 'Units were already received — their SKUs belong to this brand, so this PO can no longer migrate'
          : `Move this PO to ${brandName(target)}`}
        className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowLeftRight className="w-4 h-4" />}
        Migrate{targets.length === 1 ? ` to ${brandName(targets[0])}` : ''}
      </button>
    </div>
  );
}

// Inline add-a-line form: type a species name, pick from the catalog, set
// qty (+ price — blank uses the species' saved wholesale price). Admin-only:
// add-line is an admin action server-side.
function AddLineRow({ poId, species, showToast, onAdded }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState(null);
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (busy) return;
    if (!picked) { showToast?.('Pick a species from the suggestions first', 'error'); return; }
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n < 1) { showToast?.('Quantity must be at least 1', 'error'); return; }
    setBusy(true);
    try {
      await api.addPurchaseOrderLine({
        id: poId,
        speciesId: picked.id,
        quantityOrdered: n,
        unitWholesalePrice: price === '' ? undefined : parseFloat(price),
      });
      setName(''); setPicked(null); setQty('1'); setPrice('');
      onAdded?.();
    } catch (e) {
      showToast?.(e.message || 'Add failed', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="px-3 py-2.5 border-t border-gray-100 bg-gray-50/60 flex items-center gap-2 flex-wrap">
      <div className="flex-1 min-w-[180px]">
        <NameAutocomplete
          value={name}
          // Typing again after a pick invalidates it — the add must never
          // silently use a species that no longer matches the text.
          onChange={(v) => { setName(v); setPicked(null); }}
          onPick={(s) => {
            setPicked(s);
            setName(s.epithet);
            if (s.wholesalePrice != null) setPrice(String(s.wholesalePrice));
          }}
          candidates={species || []}
          matchField="epithet"
          inputProps={{
            placeholder: 'Add species…',
            className: 'w-full px-2 py-1.5 text-xs border border-gray-300 rounded',
          }}
        />
      </div>
      <input
        type="number"
        min={1}
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        className="w-16 px-2 py-1.5 text-xs border border-gray-300 rounded"
        title="Quantity"
      />
      <span className="text-xs text-gray-500">@ $</span>
      <input
        type="number"
        step="0.01"
        min={0}
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="catalog"
        className="w-20 px-2 py-1.5 text-xs border border-gray-300 rounded"
        title="Unit wholesale price — blank uses the species' saved price"
      />
      <button
        type="button"
        onClick={add}
        disabled={busy || !picked}
        className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
        Add
      </button>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}
