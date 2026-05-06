import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';

// Per-cultivar profit-rate field shown in each inventory group header.
// When blank, items in this cultivar fall through to the global rate.
// Saves on blur (or Enter) and shows inline validation errors via the
// title attribute so the form doesn't need its own error region.
export function CultivarRateInput({ species, globalRate, onUpdate }) {
  const [val, setVal] = useState(species?.profitRate != null ? String(species.profitRate) : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVal(species?.profitRate != null ? String(species.profitRate) : '');
    setErr('');
  }, [species?.id, species?.profitRate]);

  if (!species) return null;

  const commit = async (next) => {
    setErr('');
    setSaving(true);
    try { await onUpdate(species.id, next); }
    catch (e) { setErr(e.message || 'Save failed'); }
    setSaving(false);
  };

  const handleBlur = () => {
    const trimmed = val.trim();
    if (trimmed === '' && species.profitRate == null) return;
    if (trimmed === '') return commit(null);
    const num = parseFloat(trimmed);
    if (!Number.isFinite(num)) { setErr('Must be a number'); return; }
    if (num === species.profitRate) return;
    commit(num);
  };

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <Target className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
      <input
        type="number"
        inputMode="decimal"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        placeholder={String(globalRate ?? '')}
        disabled={saving}
        title={err || (species.profitRate == null ? `Defaults to global ${globalRate ?? '—'}%` : 'Per-cultivar rate')}
        className={`w-16 px-1.5 py-0.5 text-xs text-right tabular-nums border rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50 ${
          err ? 'border-red-400 bg-red-50' :
          species.profitRate != null ? 'border-emerald-400 bg-white text-emerald-800 font-medium' :
          'border-gray-300 bg-white text-gray-500'
        }`}
        min="0"
        step="10"
      />
      <span className="text-xs text-gray-500">%</span>
    </div>
  );
}
