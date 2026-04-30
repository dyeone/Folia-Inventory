import { useMemo, useState, useEffect } from 'react';
import { Archive, Package, DollarSign, TrendingUp, Target } from 'lucide-react';
import { StatCard } from '../ui/StatCard.jsx';

export function Dashboard({ stats, items, sales, idealRate, onIdealRateChange }) {
  const recentSold = items
    .filter(i => ['sold','shipped','delivered'].includes(i.status))
    .sort((a, b) => new Date(b.soldAt || 0) - new Date(a.soldAt || 0))
    .slice(0, 5);

  // Top varieties by profit rate (for items with cost + sale price data)
  const varietyPerformance = useMemo(() => {
    const groups = {};
    items.forEach(i => {
      if (!['sold','shipped','delivered'].includes(i.status)) return;
      const sp = parseFloat(i.salePrice);
      const cost = parseFloat(i.grossCost ?? i.cost);
      if (isNaN(sp) || sp <= 0 || isNaN(cost) || cost <= 0) return;
      const key = [i.name, i.variety].filter(Boolean).join(' · ') || 'Unlabeled';
      if (!groups[key]) groups[key] = { revenue: 0, cost: 0, count: 0 };
      groups[key].revenue += sp;
      groups[key].cost += cost;
      groups[key].count += 1;
    });
    return Object.entries(groups)
      .map(([name, g]) => ({
        name,
        count: g.count,
        revenue: g.revenue,
        profit: g.revenue - g.cost,
        profitRate: ((g.revenue - g.cost) / g.cost) * 100,
      }))
      .sort((a, b) => b.profitRate - a.profitRate)
      .slice(0, 5);
  }, [items]);

  const formatRate = (r) => r === null || r === undefined ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(0)}%`;
  const rateColor = (r) => {
    if (r === null || r === undefined) return 'gray';
    if (r >= 200) return 'emerald';
    if (r >= 100) return 'blue';
    if (r >= 0) return 'amber';
    return 'red';
  };

  // Local input state so the user can type freely without committing on every
  // keystroke; commit on blur (or Enter). Re-syncs if the prop changes from
  // outside (e.g. another tab updates localStorage).
  const [rateInput, setRateInput] = useState(String(idealRate ?? ''));
  useEffect(() => {
    // Resync local input when the prop changes from outside (e.g. another tab).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRateInput(String(idealRate ?? ''));
  }, [idealRate]);
  const commitRate = () => {
    const num = parseFloat(rateInput);
    if (Number.isFinite(num) && num !== idealRate) onIdealRateChange(num);
    else setRateInput(String(idealRate ?? ''));
  };

  // Count how many items would benefit from the global rate (no per-item
  // override) so the user can see the blast radius of changing this number.
  const itemsUsingGlobal = useMemo(() => {
    return items.filter(i => {
      const hasItemRate = !isNaN(parseFloat(i.profitRate));
      const hasItemIdeal = !isNaN(parseFloat(i.idealPrice));
      const hasCost = !isNaN(parseFloat(i.netCost)) || !isNaN(parseFloat(i.grossCost ?? i.cost));
      return !hasItemRate && !hasItemIdeal && hasCost;
    }).length;
  }, [items]);

  return (
    <div className="space-y-6">
      {/* Primary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Archive} label="Active SKUs" value={stats.totalActive} sub={`${stats.tcCount} TC · ${stats.plantCount} Plant`} color="emerald" />
        <StatCard icon={Package} label="Sold This Week" value={stats.soldThisWeek} sub={`${stats.totalSold} all-time`} color="blue" />
        <StatCard icon={DollarSign} label="Revenue / Week" value={`${stats.revenueThisWeek.toFixed(0)}`} sub={`Avg ${stats.avgPrice.toFixed(0)}/sale`} color="violet" />
        <StatCard icon={TrendingUp} label="Listed Now" value={stats.listed} sub={`${stats.shipped} shipped`} color="amber" />
      </div>

      {/* Profit stats */}
      <div>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 px-1">Profit Performance</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={TrendingUp}
            label="Avg Profit Rate"
            value={formatRate(stats.avgProfitRate)}
            sub={stats.soldWithCostCount > 0 ? `Across ${stats.soldWithCostCount} sales` : 'No sales with cost data yet'}
            color={rateColor(stats.avgProfitRate)}
          />
          <StatCard
            icon={TrendingUp}
            label="Week Profit Rate"
            value={formatRate(stats.avgProfitRateWeek)}
            sub="This week's sales"
            color={rateColor(stats.avgProfitRateWeek)}
          />
          <StatCard
            icon={DollarSign}
            label="Profit This Week"
            value={`${stats.profitThisWeek.toFixed(0)}`}
            sub={`Revenue ${stats.revenueThisWeek.toFixed(0)}`}
            color="violet"
          />
          <StatCard
            icon={DollarSign}
            label="Profit All-Time"
            value={`${stats.totalProfit.toFixed(0)}`}
            sub={`Revenue ${stats.totalRevenueAllTime.toFixed(0)}`}
            color="emerald"
          />
        </div>
      </div>

      {/* Global ideal profit rate */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-10 h-10 bg-emerald-100 text-emerald-700 rounded-lg flex items-center justify-center">
            <Target className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900">Default Ideal Profit Rate</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Used to compute the recommended selling price for items that don't have their own rate set.
              Currently applies to {itemsUsingGlobal} item{itemsUsingGlobal === 1 ? '' : 's'} in your inventory.
            </p>
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  value={rateInput}
                  onChange={(e) => setRateInput(e.target.value)}
                  onBlur={commitRate}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 tabular-nums"
                  min="0"
                  step="10"
                />
                <span className="text-sm text-gray-600">%</span>
              </div>
              <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
                Example: $10 cost → <span className="font-semibold text-emerald-700">${(10 * (1 + (parseFloat(rateInput) || 0) / 100)).toFixed(2)}</span> ideal price
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Sales</h3>
          {recentSold.length === 0 ? (
            <p className="text-sm text-gray-500">No sales yet.</p>
          ) : (
            <div className="space-y-2">
              {recentSold.map(item => {
                const sp = parseFloat(item.salePrice);
                const cost = parseFloat(item.grossCost ?? item.cost);
                const hasProfit = !isNaN(sp) && sp > 0 && !isNaN(cost) && cost > 0;
                const rate = hasProfit ? ((sp - cost) / cost) * 100 : null;
                return (
                  <div key={item.id} className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 truncate">{item.name}{item.variety ? ` · ${item.variety}` : ''}</div>
                      <div className="text-xs text-gray-500">{item.sku}{item.buyer ? ` · ${item.buyer}` : ''}</div>
                    </div>
                    <div className="text-right ml-2">
                      <div className="text-sm font-medium text-emerald-700">${parseFloat(item.salePrice || 0).toFixed(2)}</div>
                      {hasProfit && (
                        <div className={`text-xs font-medium ${
                          rate >= 100 ? 'text-emerald-600' : rate >= 0 ? 'text-amber-600' : 'text-red-600'
                        }`}>
                          {formatRate(rate)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Top Varieties by Profit Rate</h3>
          {varietyPerformance.length === 0 ? (
            <p className="text-sm text-gray-500">No sales with cost data yet. Add gross cost to items to see profit analytics.</p>
          ) : (
            <div className="space-y-2">
              {varietyPerformance.map((v, idx) => (
                <div key={idx} className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{v.name}</div>
                    <div className="text-xs text-gray-500">{v.count} sold · ${v.profit.toFixed(0)} profit</div>
                  </div>
                  <div className={`text-sm font-semibold ml-2 ${
                    v.profitRate >= 200 ? 'text-emerald-600' : v.profitRate >= 100 ? 'text-blue-600' : v.profitRate >= 0 ? 'text-amber-600' : 'text-red-600'
                  }`}>
                    {formatRate(v.profitRate)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Upcoming Sales</h3>
        {sales.length === 0 ? (
          <p className="text-sm text-gray-500">No sale events scheduled.</p>
        ) : (
          <div className="space-y-2">
            {sales.slice(0, 5).map(sale => {
              const count = items.filter(i => i.saleId === sale.id).length;
              return (
                <div key={sale.id} className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{sale.name}</div>
                    <div className="text-xs text-gray-500">{sale.date}</div>
                  </div>
                  <div className="text-sm text-gray-600">{count} lots</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
