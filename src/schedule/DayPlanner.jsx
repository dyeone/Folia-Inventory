import { useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { dayName, shortDate, fmtRange, fmtHours, hoursBetween, minutesOf, dayHours, hourRuns, fmtRuns } from './weekUtils.js';

// One day, by the hour. A row per person, a column per hour: the hours they
// said they can work are shaded (green = yes, amber = maybe), the planned
// shift sits on top as a solid block. Drag across a row to plan a shift
// (snapped to whole hours), tap a block to fine-tune it (minutes, label,
// note, split shifts). The bottom row counts who is on at each hour.

export const HOUR_START = 6;    // 6am …
export const HOUR_END = 22;     // … 10pm (the last column is 9–10pm)
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
const DAY_MIN = HOUR_START * 60;
const SPAN_MIN = (HOUR_END - HOUR_START) * 60;
const pad2 = (n) => String(n).padStart(2, '0');
const hourLabel = (h) => `${h % 12 || 12}${h >= 12 ? 'p' : 'a'}`;
const pct = (min) => `${Math.max(0, Math.min(100, ((min - DAY_MIN) / SPAN_MIN) * 100))}%`;

export function DayPlanner({ date, users, availability, shifts, onCreate, onEdit, today, currentUserId }) {
  // The drag in progress: { userId, start, end } in hour indexes. Kept in a
  // ref as well as state so pointer events that arrive before React has
  // re-rendered (a quick tap-release) still see the current drag.
  const [drag, setDragState] = useState(null);
  const dragRef = useRef(null);
  const setDrag = (d) => { dragRef.current = d; setDragState(d); };
  const rowRefs = useRef({});

  const byUser = useMemo(() => {
    const m = new Map();
    for (const s of shifts) { if (!m.has(s.userId)) m.set(s.userId, []); m.get(s.userId).push(s); }
    return m;
  }, [shifts]);

  // Who is on at each hour (any overlap with the hour counts).
  const coverage = HOURS.map((h) => {
    const a = h * 60, b = (h + 1) * 60;
    return new Set(shifts.filter((s) => minutesOf(s.from) < b && minutesOf(s.to) > a).map((s) => s.userId)).size;
  });
  const maxCover = Math.max(1, ...coverage);

  const hourAt = (userId, clientX) => {
    const el = rowRefs.current[userId];
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const idx = Math.floor(((clientX - r.left) / r.width) * HOURS.length);
    return Math.max(0, Math.min(HOURS.length - 1, idx));
  };
  const onDown = (userId) => (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest?.('[data-shift]')) return;      // a block: tap = edit, no drag
    const h = hourAt(userId, e.clientX);
    setDrag({ userId, start: h, end: h });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  };
  const onMove = (userId) => (e) => {
    const d = dragRef.current;
    if (!d || d.userId !== userId) return;
    const h = hourAt(userId, e.clientX);
    if (h !== d.end) setDrag({ ...d, end: h });
  };
  const onUp = (userId) => () => {
    const d = dragRef.current;
    if (!d || d.userId !== userId) return;
    const a = Math.min(d.start, d.end), b = Math.max(d.start, d.end);
    setDrag(null);
    onCreate(userId, date, `${pad2(HOURS[a])}:00`, `${pad2(HOURS[b] + 1)}:00`);
  };

  const dragRange = drag ? { from: HOURS[Math.min(drag.start, drag.end)] * 60, to: (HOURS[Math.max(drag.start, drag.end)] + 1) * 60 } : null;

  return (
    <div className="border border-gray-200 rounded-xl bg-white overflow-x-auto select-none">
      <div className="min-w-[860px]">
        {/* hour header */}
        <div className="grid border-b border-gray-200 bg-gray-50 text-[11px] text-gray-500" style={{ gridTemplateColumns: `11rem repeat(${HOURS.length}, minmax(0, 1fr))` }}>
          <div className="px-3 py-2 font-semibold text-gray-700 text-sm">{dayName(date)} {shortDate(date)}{date === today ? <span className="ml-1 text-emerald-700">· today</span> : ''}</div>
          {HOURS.map((h) => <div key={h} className="px-1 py-2 border-l border-gray-100 truncate">{hourLabel(h)}</div>)}
        </div>

        {users.map((u) => {
          const a = availability[u.id]?.days?.[date];
          const mine = byUser.get(u.id) || [];
          const hours = mine.reduce((n, s) => n + hoursBetween(s.from, s.to), 0);
          const offered = dayHours(a);                 // the hours they marked
          const runs = hourRuns(offered);              // contiguous blocks of them
          return (
            <div key={u.id} className="grid border-b border-gray-100 items-stretch" style={{ gridTemplateColumns: `11rem repeat(${HOURS.length}, minmax(0, 1fr))` }}>
              <div className="px-3 py-2 min-w-0">
                <div className="font-medium text-gray-900 truncate">{u.displayName}{u.id === currentUserId ? ' (you)' : ''}</div>
                <div className="text-xs text-gray-500 truncate">
                  {!a ? 'No reply' : offered.length ? `Can work ${fmtRuns(offered)}` : 'Not available'}
                  {hours ? ` · ${fmtHours(hours)} planned` : ''}
                </div>
                {a?.note && <div className="text-[11px] text-amber-800 italic truncate" title={a.note}>“{a.note}”</div>}
              </div>
              {/* the hour lane: spans every hour column */}
              <div
                ref={(el) => { rowRefs.current[u.id] = el; }}
                className={`relative h-14 cursor-crosshair ${a && !offered.length ? 'bg-gray-50' : ''}`}
                style={{ gridColumn: `2 / span ${HOURS.length}`, touchAction: 'none' }}
                onPointerDown={onDown(u.id)}
                onPointerMove={onMove(u.id)}
                onPointerUp={onUp(u.id)}
                onPointerCancel={() => setDrag(null)}
                title={a && !offered.length ? `${u.displayName} said no for this day` : 'Drag across the hours to plan a shift'}
              >
                {/* hour gridlines */}
                {HOURS.map((h, i) => <div key={h} className="absolute inset-y-0 border-l border-gray-100" style={{ left: `${(i / HOURS.length) * 100}%` }} />)}
                {/* availability shade: one block per run of marked hours */}
                {runs.map(([from, to]) => (
                  <div
                    key={from}
                    className={`absolute inset-y-1 rounded ${a?.status === 'maybe' ? 'bg-amber-100' : 'bg-emerald-100'}`}
                    style={{ left: pct(minutesOf(from)), width: `calc(${pct(minutesOf(to))} - ${pct(minutesOf(from))})` }}
                  />
                ))}
                {/* planned shifts */}
                {mine.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    data-shift={s.id}
                    onClick={() => onEdit(u.id, date, s.id)}
                    className="absolute inset-y-2 rounded-md bg-emerald-600 text-white text-xs font-semibold px-1.5 text-left truncate hover:bg-emerald-700 shadow-sm"
                    style={{ left: pct(minutesOf(s.from)), width: `calc(${pct(minutesOf(s.to))} - ${pct(minutesOf(s.from))})` }}
                    title={`${fmtRange(s.from, s.to)}${s.label ? ` · ${s.label}` : ''}${s.note ? ` — ${s.note}` : ''} (tap to edit)`}
                  >
                    {fmtRange(s.from, s.to)}{s.label ? ` · ${s.label}` : ''}
                  </button>
                ))}
                {/* drag preview */}
                {drag && drag.userId === u.id && dragRange && (
                  <div className="absolute inset-y-2 rounded-md border-2 border-dashed border-emerald-500 bg-emerald-50/60 pointer-events-none" style={{ left: pct(dragRange.from), width: `calc(${pct(dragRange.to)} - ${pct(dragRange.from)})` }} />
                )}
                {mine.length === 0 && runs.length > 0 && (
                  <button
                    type="button"
                    data-shift="use"
                    onClick={() => runs.forEach(([from, to]) => onCreate(u.id, date, from, to))}
                    className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-800 bg-white/90 border border-emerald-300 rounded-full px-2 py-0.5 hover:bg-emerald-50"
                    title="Plan a shift over the hours they said"
                  >
                    <Plus className="w-3 h-3" /> Use their hours
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {users.length === 0 && <div className="px-3 py-6 text-center text-sm text-gray-500">No team members yet — add them in Users.</div>}

        {/* coverage */}
        <div className="grid bg-gray-50 text-[11px]" style={{ gridTemplateColumns: `11rem repeat(${HOURS.length}, minmax(0, 1fr))` }}>
          <div className="px-3 py-2 font-semibold text-gray-700">On shift</div>
          {coverage.map((n, i) => (
            <div key={HOURS[i]} className="relative h-8 border-l border-gray-100">
              <div className="absolute bottom-0 inset-x-0.5 bg-emerald-300 rounded-t" style={{ height: `${(n / maxCover) * 100}%`, opacity: n ? 1 : 0 }} />
              <div className="absolute inset-0 flex items-center justify-center font-semibold text-gray-700">{n || ''}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
