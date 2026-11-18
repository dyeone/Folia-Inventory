import { useState } from 'react';
import { Printer, Trash2, RefreshCw, Loader2, CalendarDays } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { api } from '../api.js';
import { MediaEditor } from './MediaEditor.jsx';
import { POOLS, shopifyBadge, money } from './pools.js';

const TONE_TEXT = { ok: 'text-green-700', wait: 'text-gray-600', warn: 'text-amber-700', error: 'text-red-700' };

// One plant's For Sale details: its photos and video (shoot or pick on the
// phone — they upload in the background), price, pool, tag, and — in the
// Shopify pool — what its listing is doing.
export function PlantSheet({
  item, sales, openSaleIds, shopifyConnected, showToast, uploads,
  onClose, onMerged, onSyncShopify, onPrintLabel, onSetPool,
}) {
  const [price, setPrice] = useState(item.listingPrice != null && Number(item.listingPrice) > 0 ? String(item.listingPrice) : '');
  const [priceBusy, setPriceBusy] = useState(false);
  const [poolBusy, setPoolBusy] = useState(false);

  const followShopify = () => { if (item.salePool === 'shopify') onSyncShopify([item.id]); };
  const event = item.saleId ? (sales || []).find((s) => s.id === item.saleId) : null;
  const openEvent = event && openSaleIds.has(event.id) ? event : null;
  const badge = item.salePool === 'shopify' ? shopifyBadge(item, openSaleIds, shopifyConnected) : null;

  const savePrice = async () => {
    const v = parseFloat(price);
    if (!Number.isFinite(v) || v <= 0) { showToast('Enter a price above $0', 'error'); return; }
    const rounded = Math.round(v * 100) / 100;
    setPriceBusy(true);
    try {
      await api.upsertItems([{ id: item.id, listingPrice: rounded }]);
      onMerged([{ id: item.id, listingPrice: rounded }]);
      showToast(`Price ${money(rounded)}`);
      followShopify();
    } catch (err) {
      showToast(err.message || 'Could not save the price', 'error');
    } finally {
      setPriceBusy(false);
    }
  };

  const setPool = async (pool) => {
    if (pool === item.salePool) return;
    if (pool === null && !window.confirm(`Take ${item.saleCode || item.sku} out of For Sale?${item.salePool === 'shopify' ? ' Its Shopify listing is hidden.' : ''}`)) return;
    setPoolBusy(true);
    try {
      await onSetPool([item.id], pool);
      if (pool === null) onClose();
    } finally {
      setPoolBusy(false);
    }
  };

  const title = item.listingDetails?.title || item.name || item.sku;
  const priceDirty = price !== '' && Number(price) !== Number(item.listingPrice);

  return (
    <Modal title={`${item.saleCode ? `${item.saleCode} · ` : ''}${title}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <MediaEditor item={item} uploads={uploads} showToast={showToast} onMerged={onMerged} onChanged={followShopify} />

        {/* Price */}
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Price</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input
                type="number" inputMode="decimal" min="0" step="1" value={price}
                onChange={(e) => setPrice(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') savePrice(); }}
                className="input pl-7 text-base" placeholder="0"
              />
            </div>
            <button
              type="button" onClick={savePrice} disabled={priceBusy || !priceDirty}
              className="px-4 rounded-lg bg-emerald-600 text-white text-sm font-semibold disabled:opacity-40"
            >
              {priceBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
            </button>
          </div>
        </div>

        {/* Pool */}
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Pool</label>
          <div className="grid grid-cols-2 gap-2">
            {POOLS.map((p) => (
              <button
                key={p.id} type="button" disabled={poolBusy} onClick={() => setPool(p.id)}
                className={`py-2.5 rounded-lg border-2 text-sm font-semibold ${
                  item.salePool === p.id ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-gray-200 text-gray-600'
                } disabled:opacity-50`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {badge && (
            <div className={`mt-2 text-xs ${TONE_TEXT[badge.tone]} flex items-start gap-2`}>
              <span className="font-semibold shrink-0">Shopify: {badge.label}.</span>
              <span className="flex-1">{badge.detail}</span>
              {shopifyConnected && (
                <button type="button" onClick={() => onSyncShopify([item.id])} className="shrink-0 inline-flex items-center gap-1 text-gray-600 underline">
                  <RefreshCw className="w-3 h-3" /> Sync
                </button>
              )}
            </div>
          )}
        </div>

        {openEvent && (
          <div className="flex items-center gap-2 text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            <CalendarDays className="w-4 h-4 shrink-0" />
            <span>In <b>{openEvent.name}</b>{openEvent.date ? ` · ${openEvent.date}` : ''}</span>
          </div>
        )}

        <div className="text-xs text-gray-500 space-y-0.5">
          <div>SKU <span className="font-mono text-gray-700">{item.sku}</span> · {item.status}{item.variety ? ` · ${item.variety}` : ''}</div>
          {item.saleCode && <div>Code <span className="font-mono font-bold text-gray-800">{item.saleCode}</span> — on the tag and in every listing title, so the packer can find this pot.</div>}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button" onClick={() => onPrintLabel(item)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-gray-300 text-sm font-semibold text-gray-800 active:bg-gray-100"
          >
            <Printer className="w-4 h-4" /> Print tag
          </button>
          <button
            type="button" disabled={poolBusy} onClick={() => setPool(null)}
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-red-200 text-sm font-semibold text-red-700 active:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" /> Remove
          </button>
        </div>
      </div>
    </Modal>
  );
}
