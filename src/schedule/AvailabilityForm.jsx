import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, AlertCircle, CalendarCheck } from 'lucide-react';
import { api } from '../api.js';
import { weekDays, dayName, shortDate, weekLabel, todayStr, fmtRange, fmtHours, hoursBetween, DEFAULT_FROM, DEFAULT_TO } from './weekUtils.js';

// One person's availability for one week: a row per day — Yes / Maybe / No,
// hours when yes or maybe — plus a note, and the shifts planned for them
// once the week is published. Used from the packing bench (team members)
// and the Schedule tab (admins, for their own week).

const STATUS = [
  { id: 'yes', label: 'Yes', on: 'bg-emerald-600 text-white border-emerald-600' },
  { id: 'maybe', label: 'Maybe', on: 'bg-amber-500 text-white border-amber-500' },
  { id: 'no', label: 'No', on: 'bg-gray-700 text-white border-gray-700' },
];

export function AvailabilityForm({ week, onSaved, compact = false }) {
  const [data, setData] = useState(null);     // the week payload from the server
  const [days, setDays] = useState({});
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const w = await api.getShiftWeek(week);
        if (cancelled) return;
        setData(w);
        setDays(w.mine?.days || {});
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

  const setDay = (date, patch) => {
    setDays((prev) => {
      const cur = prev[date] || {};
      const next = { ...cur, ...patch };
      if ((next.status === 'yes' || next.status === 'maybe') && !next.from) { next.from = DEFAULT_FROM; next.to = DEFAULT_TO; }
      if (next.status === 'no') { next.from = null; next.to = null; }
      return { ...prev, [date]: next };
    });
    setDirty(true);
  };
  const allDays = (status) => { for (const d of dates) setDay(d, { status }); };

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const r = await api.saveShiftAvailability({ week, days, note });
      setDays(r.availability.days);
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

  const answered = dates.filter((d) => days[d]?.status).length;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="font-semibold text-gray-900">{weekLabel(week)}</div>
        <div className="text-xs text-gray-500">{answered}/7 days answered</div>
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
          <div className="flex gap-2 text-xs">
            <span className="text-gray-500 self-center">Whole week:</span>
            {STATUS.map((s) => (
              <button key={s.id} type="button" onClick={() => allDays(s.id)} className="px-2.5 py-1 rounded-full border border-gray-300 text-gray-700 hover:bg-gray-50">{s.label}</button>
            ))}
          </div>
          <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden bg-white">
            {dates.map((date) => {
              const d = days[date] || {};
              const isPast = date < today;
              return (
                <div key={date} className={`px-3 py-2.5 ${isPast ? 'opacity-60' : ''}`}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className={`w-16 shrink-0 ${date === today ? 'text-emerald-700' : 'text-gray-900'}`}>
                      <div className="font-semibold leading-tight">{dayName(date)}</div>
                      <div className="text-xs text-gray-500">{shortDate(date)}</div>
                    </div>
                    <div className="flex gap-1.5">
                      {STATUS.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setDay(date, { status: s.id })}
                          className={`min-w-[3.6rem] px-3 py-2 rounded-lg border text-sm font-semibold ${d.status === s.id ? s.on : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'}`}
                        >{s.label}</button>
                      ))}
                    </div>
                    {(d.status === 'yes' || d.status === 'maybe') && (
                      <div className="flex items-center gap-1.5 text-sm">
                        <input type="time" value={d.from || DEFAULT_FROM} onChange={(e) => setDay(date, { from: e.target.value })} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm" aria-label={`${dayName(date)} from`} />
                        <span className="text-gray-400">–</span>
                        <input type="time" value={d.to || DEFAULT_TO} onChange={(e) => setDay(date, { to: e.target.value })} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm" aria-label={`${dayName(date)} to`} />
                        {!compact && <span className="text-xs text-gray-500 ml-1">{fmtHours(hoursBetween(d.from || DEFAULT_FROM, d.to || DEFAULT_TO))}</span>}
                      </div>
                    )}
                  </div>
                  {d.status && d.status !== 'no' && !compact && (
                    <input
                      type="text"
                      value={d.note || ''}
                      onChange={(e) => setDay(date, { note: e.target.value })}
                      placeholder="Note for this day (optional)"
                      className="mt-2 w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5"
                    />
                  )}
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
