import { useMemo, useState } from 'react';
import {
  Plus, Calendar, Layers, Download, Trash2, Edit2, PackageOpen,
  Archive, Clock, Gift, CheckCircle2,
} from 'lucide-react';
import { exportPalmstreetCsv } from './palmstreetExport.js';

const STATUS_META = {
  ongoing:  { label: 'Ongoing',  cls: 'bg-emerald-100 text-emerald-800', icon: Clock },
  packing:  { label: 'Packing',  cls: 'bg-blue-100 text-blue-800',       icon: PackageOpen },
  closed:   { label: 'Closed',   cls: 'bg-gray-200 text-gray-700',       icon: CheckCircle2 },
};

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
  sales, items, onCreate, onEdit, onDelete, onBuildLineup, onSendToPacking, isAdmin,
}) {
  const [tab, setTab] = useState('active'); // 'active' | 'archive'

  const visible = useMemo(() => {
    return sales.filter(s => tab === 'archive' ? s.status === 'closed' : s.status !== 'closed');
  }, [sales, tab]);

  const exportCsv = (sale) => {
    const result = exportPalmstreetCsv(sale, items);
    if (!result.ok) alert(result.reason);
  };

  const archiveCount = sales.filter(s => s.status === 'closed').length;
  const activeCount = sales.length - archiveCount;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Sale Events</h2>
          <p className="text-sm text-gray-500 mt-0.5">From lineup to packed boxes — track each event end-to-end</p>
        </div>
        <button onClick={onCreate} className="flex items-center gap-1.5 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-medium rounded-lg self-start sm:self-auto">
          <Plus className="w-4 h-4" /> New Sale Event
        </button>
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
          onClick={() => setTab('archive')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition ${
            tab === 'archive' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 active:bg-gray-200'
          }`}
        >
          <Archive className="w-4 h-4" /> Archive
          <span className="text-xs text-gray-500">({archiveCount})</span>
        </button>
      </div>

      {visible.length === 0 ? (
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
              onBuildLineup={() => onBuildLineup(sale)}
              onSendToPacking={() => onSendToPacking(sale)}
              onExportCsv={() => exportCsv(sale)}
              onEdit={() => onEdit(sale)}
              onDelete={() => onDelete(sale.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SaleCard({ sale, items, isAdmin, onBuildLineup, onSendToPacking, onExportCsv, onEdit, onDelete }) {
  const saleLots = items.filter(i => i.saleId === sale.id && i.lotKind !== 'giveaway');
  const giveaways = items.filter(i => i.saleId === sale.id && i.lotKind === 'giveaway');
  const total = saleLots.length + giveaways.length;
  const totalValue = saleLots.reduce((s, i) => s + (parseFloat(i.listingPrice) || 0), 0);

  const meta = STATUS_META[sale.status] || STATUS_META.ongoing;
  const StatusIcon = meta.icon;

  // Packing progress: how many sale items are sold/shipped vs still
  // outstanding for this sale.
  const soldOrShipped = saleLots.filter(i => ['sold', 'shipped', 'delivered'].includes(i.status)).length;
  const shipped = saleLots.filter(i => ['shipped', 'delivered'].includes(i.status)).length;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
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
          {sale.status !== 'closed' && (
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
            <span>{shipped}/{saleLots.length} shipped · {soldOrShipped}/{saleLots.length} sold</span>
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

      <SaleActions
        sale={sale}
        total={total}
        onBuildLineup={onBuildLineup}
        onSendToPacking={onSendToPacking}
        onExportCsv={onExportCsv}
      />
    </div>
  );
}

function Stat({ label, value, icon: Icon }) {
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-gray-500 flex items-center gap-1">
        {Icon && <Icon className="w-3 h-3" />} {label}
      </div>
      <div className="font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function SaleActions({ sale, total, onBuildLineup, onSendToPacking, onExportCsv }) {
  if (sale.status === 'closed') {
    return (
      <div className="text-xs text-gray-500 text-center py-2 bg-gray-50 rounded-lg">
        Sale complete — all boxes shipped
      </div>
    );
  }

  if (sale.status === 'packing') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onExportCsv}
          className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-gray-100 hover:bg-gray-200 active:bg-gray-300 text-gray-800 text-sm font-medium rounded-lg"
        >
          <Download className="w-4 h-4" /> Re-export CSV
        </button>
        <div className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-blue-50 text-blue-800 text-sm font-medium rounded-lg">
          <PackageOpen className="w-4 h-4" /> In Packing tab
        </div>
      </div>
    );
  }

  // ongoing
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onBuildLineup}
          className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-emerald-50 hover:bg-emerald-100 active:bg-emerald-200 text-emerald-700 text-sm font-medium rounded-lg transition"
        >
          <Layers className="w-4 h-4" /> Build Lineup
        </button>
        <button
          onClick={onExportCsv}
          disabled={total === 0}
          className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-gray-900 hover:bg-gray-800 active:bg-black disabled:bg-gray-300 text-white text-sm font-medium rounded-lg transition"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>
      <button
        onClick={onSendToPacking}
        disabled={total === 0}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-gray-300 text-white text-sm font-medium rounded-lg transition"
      >
        <PackageOpen className="w-4 h-4" /> Send to Packing
      </button>
    </div>
  );
}
