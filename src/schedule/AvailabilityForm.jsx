import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, AlertCircle, CalendarCheck, Eraser } from 'lucide-react';
import { api } from '../api.js';
import { weekDays, dayName, shortDate, weekLabel, todayStr, fmtRange, fmtHours, hoursBetween, PICK_HOURS, fmtRuns, dayHours } from './weekUtils.js';

// One person's availability for one week, BY THE HOUR: a row per day, a
// cell per hour (6am–10pm) — tap or drag to mark the hours you can work —
// plus a note, and the shifts planned for you once the week is published.
// Used from the streamer screen and the Schedule tab (admins, their own).

const hourLabel = (h) => (h % 12 || 12) + (h >= 12 ? 'p' : 'a');

export function AvailabilityForm({ week, onSaved }) {
  const [data, setData] = useState(null);     // the week payload from the server
  const [hours, setHours] = useState({});     // date → Set of hour numbers
  const [notes, setNotes] = useState({});     // date → note
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);
  const paint = useRef(null);                 // { date, on } while dragging

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const w = await api.getShiftWeek(week);
        if (cancelled) return;
        setData(w);
        const h = {}, n = {};
        for (const [date, d] of Object.entries(w.mine?.days || {})) { h[date] = new Set(dayHours(d)); n[date] = d.note || ''; }
        setHours(h);
        setNotes(n);
        setNote(w.mine?.note || '');
        setDirty(false);
      } catch (e) {
        if (!cancelled) setErr(e.message || 'Could not load this week.');
      }
    })();
    return () => { cancelled = true; };
  }, [week]);

  const dates = useMemo(() => weekDays(week), [week]);
  const today = todayStr();
  const myShifts = useMemo(() => (data?.schedule?.shifts || []).filter((s) => s.userId === data?.me), [data]);
  const plannedHours = myShifts.reduce((n, s) => n + hoursBetween(s.from, s.to), 0);

  const setHour = (date, h, on) => {
    setHours((prev) => {
      const cur = new Set(prev[date] || []);
      if (on) cur.add(h); else cur.delete(h);
      return { ...prev, [date]: cur };
    });
    setDirty(true);
  };
  const has = (date, h) => !!hours[date]?.has(h);
  const onDown = (date, h) => (e) => {
    e.preventDefault();
    const on = !has(date, h);
    paint.current = { date, on };
    setHour(date, h, on);
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* fine */ }
  };
  // While dragging, the cell under the pointer takes the paint colour. The
  // pointer is captured by the first cell, so look the target up by point.
  const onMove = (e) => {
    const p = paint.current;
    if (!p) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest?.('[data-hour]');
    if (!cell || cell.dataset.date !== p.date) return;
    const h = Number(cell.dataset.hour);
    if (has(p.date, h) !== p.on) setHour(p.date, h, p.on);
  };
  const onUp = () => { paint.current = null; };

  const setDayAll = (date, on, list = PICK_HOURS) => { setHours((prev) => ({ ...prev, [date]: on ? new Set(list) : new Set() })); setDirty(true); };
  const weekdays9to5 = () => { dates.forEach((d, i) => setDayAll(d, i < 5, [9, 10, 11, 12, 13, 14, 15, 16])); };
  const clearAll = () => { dates.forEach((d) => setDayAll(d, false)); };

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const days = {};
      for (const d of dates) days[d] = { hours: [...(hours[d] || [])].sort((a, b) => a - b), note: notes[d] || '' };
      const r = await api.saveShiftAvailability({ week, days, note });
      const h = {}, n = {};
      for (const [date, d] of Object.entries(r.availability.days || {})) { h[date] = new Set(dayHours(d)); n[date] = d.note || ''; }
      setHours(h); setNotes(n);
      setNote(r.availability.note || '');
      setData((d) => (d ? { ...d, mine: r.availability } : d));
      setSavedAt(new Date());
      setDirty(false);
      onSaved?.(r.availability);
    } catch (e) {
      setErr(e.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const totalHours = dates.reduce((n, d) => n + (hours[d]?.size || 0), 0);

  return (
    <div className="space-y-3" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="font-semibold text-gray-900">{weekLabel(week)}</div>
        <div className="text-xs text-gray-500">{fmtHours(totalHours)} offered</div>
      </div>
      {!data && !err && <div className="flex items-center gap-2 text-sm text-gray-500 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
      {err && <div className="flex items-center gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg"><AlertCircle className="w-4 h-4 shrink-0" /> {err}</div>}
      {data && (
        <>
          {data.schedule?.published ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900"><CalendarCheck className="w-4 h-4" /> Your shifts this week{plannedHours ? ` · ${fmtHours(plannedHours)}` : ''}</div>
              {myShifts.length === 0 ? (
                <div className="text-sm text-emerald-800 mt-1">No shifts planned for you this week.</div>
              ) : (
                <ul className="mt-1 space-y-0.5 text-sm text-emerald-900">
                  {myShifts.map((s) => (
                    <li key={s.id}><span className="font-medium">{dayName(s.date)} {shortDate(s.date)}</span> · {fmtRange(s.from, s.to)}{s.label ? ` · ${s.label}` : ''}{s.note ? ` — ${s.note}` : ''}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-500">{data.schedule?.hidden ? 'The schedule for this week is being planned.' : 'No schedule published for this week yet.'}</div>
          )}

          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="text-gray-500">Tap or drag the hours you can work.</span>
            <button type="button" onClick={weekdays9to5} className="ml-auto px-2.5 py-1 rounded-full border border-gray-300 text-gray-700 hover:bg-gray-50">Weekdays 9–5</button>
            <button type="button" onClick={clearAll} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-gray-300 text-gray-700 hover:bg-gray-50"><Eraser className="w-3 h-3" /> Clear</button>
          </div>

          <div className="border border-gray-200 rounded-xl overflow-hidden bg-white select-none" style={{ touchAction: 'none' }}>
            <div className="grid text-[10px] text-gray-500 bg-gray-50 border-b border-gray-200" style={{ gridTemplateColumns: `4.5rem repeat(${PICK_HOURS.length}, minmax(0, 1fr))` }}>
              <div />
              {PICK_HOURS.map((h) => <div key={h} className="text-center py-1 truncate">{h % 2 === 0 ? hourLabel(h) : ''}</div>)}
            </div>
            {dates.map((date) => {
              const isPast = date < today;
              const set = hours[date] || new Set();
              return (
                <div key={date} className={`border-b border-gray-100 ${isPast ? 'opacity-50' : ''}`}>
                  <div className="grid items-stretch" style={{ gridTemplateColumns: `4.5rem repeat(${PICK_HOURS.length}, minmax(0, 1fr))` }}>
                    <button
                      type="button"
                      onClick={() => setDayAll(date, set.size === 0)}
                      title={set.size ? 'Clear this day' : 'Mark the whole day'}
                      className={`text-left px-2 py-1.5 ${date === today ? 'text-emerald-700' : 'text-gray-900'}`}
                    >
                      <div className="text-sm font-semibold leading-tight">{dayName(date)}</div>
                      <div className="text-[11px] text-gray-500">{shortDate(date)}</div>
                    </button>
                    {PICK_HOURS.map((h) => {
                      const on = set.has(h);
                      return (
                        <div
                          key={h}
                          data-hour={h}
                          data-date={date}
                          role="checkbox"
                          aria-checked={on}
                          aria-label={`${dayName(date)} ${hourLabel(h)}`}
                          onPointerDown={onDown(date, h)}
                          className={`h-10 border-l border-gray-100 ${on ? 'bg-emerald-500' : 'bg-white'} ${h === 12 ? 'border-l-gray-300' : ''}`}
                        />
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 px-2 pb-1.5">
                    <div className="text-xs text-gray-600 min-w-0 truncate">{set.size ? `${fmtRuns([...set])} · ${fmtHours(set.size)}` : 'Not available'}</div>
                    <input
                      type="text"
                      value={notes[date] || ''}
                      onChange={(e) => { setNotes((n) => ({ ...n, [date]: e.target.value })); setDirty(true); }}
                      placeholder="note"
                      className="ml-auto w-28 sm:w-44 text-xs border border-gray-200 rounded-lg px-2 py-1"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <textarea
            value={note}
            onChange={(e) => { setNote(e.target.value); setDirty(true); }}
            placeholder="Anything the planner should know this week (optional)"
            rows={2}
            className="w-full text-sm border border-gray-300 rounded-xl px-3 py-2"
          />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs text-gray-500">
              {savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : data.mine?.updatedAt ? `Last saved ${new Date(data.mine.updatedAt).toLocaleDateString()}` : 'Not submitted yet'}
            </div>
            <button
              type="button"
              onClick={save}
              disabled={saving || (!dirty && !!data.mine)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 text-white font-semibold text-sm disabled:opacity-40 hover:bg-emerald-700"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {data.mine && !dirty ? 'Submitted' : 'Submit availability'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
