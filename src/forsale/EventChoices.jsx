import { Check, Loader2 } from 'lucide-react';
import { eventStyle, saleDay } from './pools.js';

const dayLabel = (sale) => {
  const d = saleDay(sale);
  return d ? new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '';
};

// Pick a sale event for plants (2026-11-19, operator: "there are several
// sale events — Palmstreet purge, Palmstreet live, website sale — the user
// needs to select the sale event to separate the plants"). `events` are the
// upcoming ones (openEvents); `value` the one the plant is in (null = none,
// undefined = several plants, nothing marked). `busy` is the id being
// saved ('none' for No event).
export function EventChoices({ events, value, busy, disabled, onPick }) {
  const row = (id, label, sub, st) => {
    const on = value !== undefined && (value ?? null) === id;
    const key = id ?? 'none';
    return (
      <button
        key={key} type="button" disabled={disabled || !!busy} onClick={() => onPick(id)}
        aria-pressed={on}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border-2 text-left disabled:opacity-60 ${on ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 bg-white active:bg-gray-50'}`}
      >
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st ? st.dot : 'bg-gray-300'}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-gray-900 truncate">{label}</span>
          {sub && <span className="block text-[11px] text-gray-500 truncate">{sub}</span>}
        </span>
        {busy === key ? <Loader2 className="w-4 h-4 animate-spin text-gray-500 shrink-0" />
          : on ? <Check className="w-4 h-4 text-emerald-600 shrink-0" strokeWidth={3} /> : null}
      </button>
    );
  };
  return (
    <div className="space-y-1.5">
      {events.map((s) => {
        const st = eventStyle(s);
        return row(s.id, s.name, [st.label, dayLabel(s)].filter(Boolean).join(' · '), st);
      })}
      {row(null, 'No event', 'Just in the pool', null)}
      {events.length === 0 && (
        <p className="text-[11px] text-gray-500">No upcoming events — create one on the Calendar (Palmstreet live, Palmstreet purge or Website sale).</p>
      )}
    </div>
  );
}
