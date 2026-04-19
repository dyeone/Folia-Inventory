import { Filter } from 'lucide-react';

export function FilterPill({ label, value, onChange, options }) {
  return (
    <div className="flex items-center gap-1.5 bg-gray-50 rounded-lg px-2 py-1">
      <Filter className="w-3.5 h-3.5 text-gray-400" />
      <span className="text-xs text-gray-600">{label}:</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="text-xs bg-transparent border-0 focus:outline-none text-gray-900 font-medium cursor-pointer">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
