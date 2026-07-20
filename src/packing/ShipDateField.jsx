import { CalendarDays } from 'lucide-react';
import { localDateStr, shipDateProblem } from './shipDate.js';

// Every label purchase carries an explicit ship date — the date sent to the
// carrier and printed on the label — instead of silently assuming today
// (labels are often bought the evening before drop-off). The field starts
// EMPTY on purpose: the operator must pick the date before any buy button
// arms, so a stale "today" can never sneak onto a label.
// (Date helpers live in shipDate.js so this file only exports a component.)

// One horizontal row: label · date input · Today / Tomorrow quick picks.
// The input glows amber until a valid date is chosen — it's the required
// first step of every buy flow.
export function ShipDateField({ value, onChange, disabled }) {
  const today = localDateStr(0);
  const tomorrow = localDateStr(1);
  const problem = shipDateProblem(value);
  const chip = (label, date) => (
    <button
      type="button"
      onClick={() => onChange(date)}
      disabled={disabled}
      className={`text-xs font-medium px-2 py-1 rounded-md border transition disabled:opacity-50 ${
        value === date
          ? 'bg-emerald-100 border-emerald-300 text-emerald-900'
          : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-gray-700">
        <CalendarDays className="w-3.5 h-3.5 text-gray-500" /> Ship date
      </span>
      <input
        type="date"
        value={value}
        min={today}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label="Ship date"
        className={`px-2 py-1 border rounded-lg text-sm bg-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
          problem ? 'border-amber-400 ring-1 ring-amber-300' : 'border-gray-300'
        }`}
      />
      {chip('Today', today)}
      {chip('Tomorrow', tomorrow)}
    </div>
  );
}
