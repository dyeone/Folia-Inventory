import { Check, AlertCircle } from 'lucide-react';

// "Which column is which?" — shown when a supplier file's columns can't be
// recognised: a PDF table whose header names mean nothing to us, or a
// sheet with no header at all (where the old behaviour was to silently
// take columns A/B/C as plant/qty/price). The operator points at the
// columns; nothing is imported until they confirm. One component for the
// import and update-order modals so the two can't drift.
//
//   columns: [{ index, label, samples: [string…] }]   from gridColumns()
//   roles:   { species?, qty?, price?, variety? }      column index per role
//   onChange(roles) · onConfirm() · message: why we're asking

const MAPPER_ROLES = [
  { key: 'species', label: 'Plant name', required: true },
  { key: 'qty', label: 'Quantity' },
  { key: 'price', label: 'Unit price' },
  { key: 'variety', label: 'Genus' },
];

export function ColumnMapper({ columns, roles, onChange, onConfirm, message, busy = false }) {
  const roleOf = (idx) => MAPPER_ROLES.find((r) => roles[r.key] === idx)?.key || '';
  const setRole = (idx, key) => {
    const next = { ...roles };
    for (const r of MAPPER_ROLES) if (next[r.key] === idx) delete next[r.key];   // a column plays one role
    if (key) next[key] = idx;                                                     // and a role sits in one column
    onChange(next);
  };
  const ready = roles.species !== undefined;
  const sampleRows = Math.max(0, ...columns.map((c) => c.samples.length));

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
      <div className="flex items-start gap-2 text-xs text-amber-900">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold">Which column is which?</div>
          <div>{message || 'The columns in this file were not recognised. Pick the plant name column (and quantity and price if the file has them), then continue.'}</div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse min-w-full">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.index} className="p-1 align-top">
                  <select
                    value={roleOf(c.index)}
                    onChange={(e) => setRole(c.index, e.target.value)}
                    className={`w-full min-w-[7.5rem] border rounded px-1.5 py-1 bg-white font-medium ${roleOf(c.index) ? 'border-emerald-400 text-emerald-800' : 'border-gray-300 text-gray-600'}`}
                    aria-label={`Role of ${c.label}`}
                  >
                    <option value="">— ignore —</option>
                    {MAPPER_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}{r.required ? ' *' : ''}</option>)}
                  </select>
                </th>
              ))}
            </tr>
            <tr>
              {columns.map((c) => (
                <th key={c.index} className="px-2 py-1 text-left font-semibold text-gray-700 bg-white border-b border-gray-200 whitespace-nowrap">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: sampleRows }, (_, ri) => (
              <tr key={ri} className="bg-white">
                {columns.map((c) => (
                  <td key={c.index} className="px-2 py-1 text-gray-700 border-b border-gray-100 max-w-[14rem] truncate whitespace-nowrap" title={c.samples[ri] || ''}>{c.samples[ri] || ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-amber-800">* required · rows without a quantity count as 1 plant</span>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={onConfirm}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold disabled:opacity-40 hover:bg-emerald-700"
        >
          <Check className="w-3.5 h-3.5" /> Use these columns
        </button>
      </div>
    </div>
  );
}
