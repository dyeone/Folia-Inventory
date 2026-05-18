export function StatCard({ icon, label, value, sub, color }) {
  const Icon = icon;
  const colorMap = {
    emerald: 'bg-emerald-50 text-emerald-700',
    blue: 'bg-blue-50 text-blue-700',
    violet: 'bg-violet-50 text-violet-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
    gray: 'bg-gray-100 text-gray-600',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4">
      <div className="flex items-center justify-between mb-1.5 sm:mb-2 gap-2">
        <span className="text-[11px] sm:text-xs font-medium text-gray-600 leading-tight truncate">{label}</span>
        <div className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center ${colorMap[color] || colorMap.gray}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className="text-xl sm:text-2xl font-semibold text-gray-900 tabular-nums leading-tight truncate">{value}</div>
      {sub && <div className="text-[11px] sm:text-xs text-gray-500 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
