import { useMemo, useState } from 'react';
import {
  Plus, Calendar, Layers, Download, Trash2, Edit2, PackageOpen,
  Archive, Clock, Gift, CheckCircle2, Upload, Check, Lock, Radio, Tag,
  BarChart3, FileText, Users, Coins, Video, Music2,
} from 'lucide-react';
import { PreSaleTab } from './PreSaleTab.jsx';
import { hasEval } from './saleEval.js';
import { TikTokLiveModal } from './TikTokLiveModal.jsx';
const STATUS_META = {
  ongoing:  { label: 'Ongoing',  cls: 'bg-emerald-100 text-emerald-800', icon: Clock },
  packing:  { label: 'Packing',  cls: 'bg-blue-100 text-blue-800',       icon: PackageOpen },
  closed:   { label: 'Closed',   cls: 'bg-gray-200 text-gray-700',       icon: CheckCircle2 },
};

const SOLD_STATUSES = new Set(['sold', 'shipped', 'delivered', 'refunded']);

function formatStart(sale) {
  if (sale.startTime) {
    const d = new Date(sale.startTime);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    }
  }
  return sale.date || '';
}

export function SalesView({
  sales, items, onCreate, onEdit, onDelete, onBuildLineup, onExportCsv,
  onSendToPacking, onGoLive, onValidateSales, onValidateTikTok, onStartLiveScan, isAdmin,
  onStageItems, onItemsChanged, showToast,
  onEvaluateSale, onViewReport, evalVersion, evalSaleIds,
  activeBrand, sellers = [], varieties = [], species = [],
  onManageSellers, onSellerSettlement, onIntakeSeller, onReloadSellers,
  onPrintLabels,
}) {
  const [tab, setTab] = useState('active');
  // TikTok live setup modal (bulk-load TC per PO + Seller Center export).
  const [tiktokSale, setTiktokSale] = useState(null);
  const speciesById = useMemo(() => new Map((species || []).map(s => [s.id, s])), [species]);
  // Consignment (seller sections + settlement) is a BAE-only workflow.
  const isBae = activeBrand === 'bae';

  const visible = useMemo(() => {
    return sales.filter(s => tab === 'archive' ? s.status === 'closed' : s.status !== 'closed');
  }, [sales, tab]);

  const archiveCount = sales.filter(s => s.status === 'closed').length;
  const activeCount = sales.length - archiveCount;

  // Items already staged into an upcoming (non-closed) sale's lineup.
  const presaleCount = useMemo(() => {
    const openSaleIds = new Set(sales.filter(s => s.status !== 'closed').map(s => s.id));
    return items.filter(i => i.saleId && openSaleIds.has(i.saleId)).length;
  }, [sales, items]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Sale Events</h2>
          <p className="text-sm text-gray-500 mt-0.5">From lineup to packed boxes — track each event end-to-end</p>
        </div>
        <div className="flex flex-wrap gap-2 self-start sm:self-auto">
          {onStartLiveScan && (
            <button
              onClick={onStartLiveScan}
              title="Open the live-scan window — every barcode scan auto-pushes the SKU to Palmstreet"
              className="flex items-center gap-1.5 px-4 py-2.5 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-medium rounded-lg"
            >
              <Radio className="w-4 h-4" /> Start Live Mode
            </button>
          )}
          {onValidateSales && (
            <button
              onClick={onValidateSales}
              title="Match a Palmstreet orders file against any sale's lineup, then update inventory"
              className="flex items-center gap-1.5 px-4 py-2.5 bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 active:bg-emerald-100 text-sm font-medium rounded-lg"
            >
              <Upload className="w-4 h-4" /> Validate Sales
            </button>
          )}
          {onValidateTikTok && (
            <button
              onClick={onValidateTikTok}
              title='Match a TikTok Seller Center "To Ship" export against inventory, then create TikTok boxes — kept separate from Palmstreet boxes'
              className="flex items-center gap-1.5 px-4 py-2.5 bg-black border border-black text-white hover:bg-gray-800 active:bg-gray-900 text-sm font-medium rounded-lg"
            >
              <Music2 className="w-4 h-4 text-cyan-300" /> TikTok Orders
            </button>
          )}
          {isBae && (
            <button
              onClick={onManageSellers}
              title="Manage consignment sellers — their plants can be added to any event"
              className="flex items-center gap-1.5 px-4 py-2.5 bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 active:bg-emerald-100 text-sm font-medium rounded-lg"
            >
              <Users className="w-4 h-4" /> Sellers
            </button>
          )}
          <button onClick={onCreate} className="flex items-center gap-1.5 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-medium rounded-lg">
            <Plus className="w-4 h-4" /> New Sale Event
          </button>
        </div>
      </div>

      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        <button
          onClick={() => setTab('active')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition ${
            tab === 'active' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 active:bg-gray-200'
          }`}
        >
          <Clock className="w-4 h-4" /> Active
          <span className="text-xs text-gray-500">({activeCount})</span>
        </button>
        <button
          onClick={() => setTab('presale')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition ${
            tab === 'presale' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 active:bg-gray-200'
          }`}
        >
          <Tag className="w-4 h-4" /> Pre Sale
          <span className="text-xs text-gray-500">({presaleCount})</span>
        </button>
        <button
          onClick={() => setTab('archive')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition ${
            tab === 'archive' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 active:bg-gray-200'
          }`}
        >
          <Archive className="w-4 h-4" /> Archive
          <span className="text-xs text-gray-500">({archiveCount})</span>
        </button>
      </div>

      {tab === 'presale' ? (
        <PreSaleTab
          sales={sales}
          items={items}
          showToast={showToast}
          onStageItems={onStageItems}
          onItemsChanged={onItemsChanged}
          isBae={isBae}
          sellers={sellers}
          varieties={varieties}
          onIntakeSeller={onIntakeSeller}
          onManageSellers={onManageSellers}
          onReloadSellers={onReloadSellers}
          onPrintLabels={onPrintLabels}
        />
      ) : visible.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">
            {tab === 'archive' ? 'No closed sales yet.' : 'No active sales yet. Create one to organize your auction lineup.'}
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visible.map(sale => (
            <SaleCard
              key={sale.id}
              sale={sale}
              items={items}
              isAdmin={isAdmin}
              isBae={isBae}
              onBuildLineup={() => onBuildLineup(sale)}
              onExportCsv={() => onExportCsv(sale)}
              onSendToPacking={() => onSendToPacking(sale)}
              onGoLive={() => onGoLive(sale)}
              onEdit={() => onEdit(sale)}
              onDelete={() => onDelete(sale.id)}
              onEvaluateSale={() => onEvaluateSale(sale)}
              onViewReport={() => onViewReport(sale)}
              onSellerSettlement={() => onSellerSettlement(sale)}
              onTikTok={() => setTiktokSale(sale)}
              evalVersion={evalVersion}
              hasDbEval={!!evalSaleIds && evalSaleIds.has(sale.id)}
            />
          ))}
        </div>
      )}
      {tiktokSale && (
        <TikTokLiveModal
          sale={tiktokSale}
          sales={sales}
          items={items}
          speciesById={speciesById}
          showToast={showToast}
          onItemsChanged={onItemsChanged}
          onClose={() => setTiktokSale(null)}
        />
      )}
    </div>
  );
}

function SaleCard({
  sale, items, isAdmin, isBae,
  onBuildLineup, onExportCsv, onSendToPacking, onGoLive, onEdit, onDelete,
  onEvaluateSale, onViewReport, onSellerSettlement, onTikTok, evalVersion, hasDbEval,
}) {
  // TikTok lives sell TC: inventory loads in bulk per purchase order and
  // exports as Seller Center's bulk-listing file — its own setup flow.
  const isTikTok = /tiktok/i.test(sale.platform || '');
  // Show "Financial Report" if a report exists in the DB (hasDbEval) OR in this
  // browser's localStorage cache. Re-check the cache when evalVersion bumps
  // (a report was just generated); `void evalVersion` makes that cache-bust
  // dependency explicit since hasEval reads localStorage the linter can't see.
  const reportReady = useMemo(
    () => { void evalVersion; return hasDbEval || hasEval(sale.id); },
    [sale.id, evalVersion, hasDbEval],
  );
  const saleLots = items.filter(i => i.saleId === sale.id && i.lotKind !== 'giveaway');
  const giveaways = items.filter(i => i.saleId === sale.id && i.lotKind === 'giveaway');
  // Consignment plants in this event → enables the per-seller settlement report.
  const sellerCount = items.filter(i => i.saleId === sale.id && i.sellerId).length;
  const totalAssigned = saleLots.length + giveaways.length;
  const totalValue = saleLots.reduce((s, i) => s + (parseFloat(i.listingPrice) || 0), 0);

  const meta = STATUS_META[sale.status] || STATUS_META.ongoing;
  const StatusIcon = meta.icon;

  // Step completion derived from sale + items state.
  const step1Done = totalAssigned > 0;
  const step2Done = !!sale.exportedAt;
  const soldCount = saleLots.filter(i => SOLD_STATUSES.has(i.status)).length;
  // "Validated" = at least one of this sale's lineup items has been marked
  // sold. Validation lives outside the per-sale card now (top-level
  // Validate Sales button), but we still gate Send-to-Packing on it.
  const validated = soldCount > 0;
  const sentToPacking = sale.status === 'packing' || sale.status === 'closed';

  const shipped = saleLots.filter(i => ['shipped', 'delivered'].includes(i.status)).length;
  const isClosed = sale.status === 'closed';

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${meta.cls}`}>
              <StatusIcon className="w-3 h-3" /> {meta.label}
            </span>
            {sale.itemTypes && sale.itemTypes !== 'both' && (
              <span className="text-[11px] text-gray-500 uppercase tracking-wide">
                {sale.itemTypes} only
              </span>
            )}
          </div>
          <div className="font-medium text-gray-900 truncate">{sale.name}</div>
          <div className="text-xs text-gray-500">
            {formatStart(sale)}
            {sale.durationMinutes ? ` · ${sale.durationMinutes} min` : ''}
            {sale.platform ? ` · ${sale.platform}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!isClosed && (
            <button onClick={onEdit} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg" title="Edit" aria-label="Edit">
              <Edit2 className="w-4 h-4" />
            </button>
          )}
          {isAdmin && (
            <button onClick={onDelete} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 rounded-lg" title="Delete (admin only)" aria-label="Delete">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs mb-3">
        <Stat label="Lots" value={saleLots.length} />
        <Stat label="Giveaways" value={giveaways.length} icon={Gift} />
        <Stat label="Listing $" value={`$${totalValue.toFixed(0)}`} />
      </div>

      {(sale.status === 'packing' || sale.status === 'closed') && saleLots.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-[11px] text-gray-500 mb-1">
            <span>Packing progress</span>
            <span>{shipped}/{saleLots.length} shipped</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${saleLots.length ? (shipped / saleLots.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {sale.notes && <p className="text-xs text-gray-600 mb-3 line-clamp-2">{sale.notes}</p>}

      {isClosed ? (
        <div className="text-xs text-gray-500 text-center py-3 bg-gray-50 rounded-lg mt-auto">
          Sale complete — all boxes shipped
        </div>
      ) : (
        <div className="space-y-2 mt-auto">
          {isTikTok && (
            <button
              onClick={onTikTok}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 bg-gray-900 hover:bg-black active:bg-black text-white text-sm font-semibold rounded-lg transition shadow-sm"
            >
              <Video className="w-4 h-4" /> TikTok live — load TC &amp; export
            </button>
          )}
          {step1Done && sale.status === 'ongoing' && (
            <button
              onClick={onGoLive}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-semibold rounded-lg transition shadow-sm"
            >
              <Radio className="w-4 h-4 animate-pulse" /> On Live
            </button>
          )}
          <div className="space-y-1.5">
          <Step
            n={1} title="Build Lineup" done={step1Done}
            actionLabel={step1Done ? 'Edit lineup' : 'Build lineup'}
            actionIcon={Layers}
            onAction={onBuildLineup}
          />
          <Step
            n={2} title="Export CSV to Palmstreet" done={step2Done}
            actionLabel={step2Done ? 'Re-export CSV' : 'Export CSV'}
            actionIcon={Download}
            onAction={onExportCsv}
            disabled={!step1Done}
            hint={step2Done && sale.exportedAt
              ? `Exported ${new Date(sale.exportedAt).toLocaleDateString()}`
              : null}
          />
          <Step
            n={3} title="Send to Packing" done={sentToPacking}
            actionLabel={sentToPacking ? 'In Packing tab' : 'Send to Packing'}
            actionIcon={PackageOpen}
            onAction={onSendToPacking}
            disabled={!validated || sentToPacking}
            hint={sentToPacking ? `${shipped}/${saleLots.length} shipped` : null}
          />
          </div>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-gray-100 flex gap-2">
        <button
          onClick={onEvaluateSale}
          title="Upload a Palmstreet orders CSV to evaluate this live's sales — read-only, no item status changes"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 active:bg-emerald-100"
        >
          <BarChart3 className="w-3.5 h-3.5" /> Evaluate Sales
        </button>
        {reportReady && (
          <button
            onClick={onViewReport}
            title="View the financial report generated from the uploaded orders"
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white"
          >
            <FileText className="w-3.5 h-3.5" /> Financial Report
          </button>
        )}
      </div>
      {isBae && sellerCount > 0 && (
        <div className="mt-2 flex">
          <button
            onClick={onSellerSettlement}
            title="Per-seller settlement — what sold, our commission, and what's owed to each seller"
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-white border border-amber-300 text-amber-700 hover:bg-amber-50 active:bg-amber-100"
          >
            <Coins className="w-3.5 h-3.5" /> Seller Settlement
            <span className="text-amber-400">· {sellerCount}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function Step(props) {
  const { n, title, done, actionLabel, actionIcon: Icon, onAction, disabled, hint } = props;
  const locked = disabled && !done;
  return (
    <div className={`flex items-center gap-2.5 py-1.5 ${locked ? 'opacity-50' : ''}`}>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0 ${
        done ? 'bg-emerald-600 text-white'
        : locked ? 'bg-gray-200 text-gray-500'
        : 'bg-emerald-100 text-emerald-700 ring-2 ring-emerald-200'
      }`}>
        {done ? <Check className="w-3.5 h-3.5" /> : locked ? <Lock className="w-3 h-3" /> : n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-gray-900 truncate">{title}</div>
        {hint && <div className="text-[11px] text-gray-500 truncate">{hint}</div>}
      </div>
      <button
        onClick={onAction}
        disabled={disabled}
        className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg transition flex-shrink-0 ${
          done
            ? 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 active:bg-gray-100'
            : disabled
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white'
        }`}
      >
        <Icon className="w-3.5 h-3.5" /> {actionLabel}
      </button>
    </div>
  );
}

function Stat(props) {
  const { label, value, icon: Icon } = props;
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-gray-500 flex items-center gap-1">
        {Icon && <Icon className="w-3 h-3" />} {label}
      </div>
      <div className="font-semibold text-gray-900">{value}</div>
    </div>
  );
}
