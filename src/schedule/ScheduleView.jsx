import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, Loader2, AlertCircle, Copy, Send, Undo2, CalendarDays, Plus, Trash2, X, Clock, LayoutGrid } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from '../ui/Modal.jsx';
import { AvailabilityModal } from './AvailabilityModal.jsx';
import { DayPlanner } from './DayPlanner.jsx';
import { mondayOf, todayStr, addDays, weekDays, dayName, shortDate, weekLabel, fmtRange, fmtHours, hoursBetween, dayHours, hourRuns, fmtRuns, DEFAULT_FROM, DEFAULT_TO } from './weekUtils.js';

// Schedule tab (admins): one week at a time, planned BY THE HOUR. The
// default view is one day as an hour grid (DayPlanner): a row per person,
// their availability shaded, shifts as blocks — drag across the hours to
// plan, tap a block to fine-tune. The week view is the overview: rows are
// the team, columns the seven days, each cell what the person said and the
// shift(s) on top; click a cell to plan it. The plan is a draft until
// Publish, which is when team members see their shifts on the bench.

const AVAIL_STYLE = {
  yes: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  maybe: 'bg-amber-50 text-amber-800 border-amber-200',
  no: 'bg-gray-100 text-gray-500 border-gray-200',
  none: 'bg-white text-gray-400 border-dashed border-gray-200',
};

export function ScheduleView({ currentUser, showToast }) {
  const [week, setWeek] = useState(() => mondayOf(todayStr()));
  const [view, setView] = useState('day');          // 'day' (by the hour) | 'week' (overview)
  const [day, setDay] = useState(() => todayStr());  // the day open in the hour view
  const [data, setData] = useState(null);
  const [shifts, setShifts] = useState([]);
  const [published, setPublished] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);   // { userId, date }
  const [myAvailOpen, setMyAvailOpen] = useState(false);
  const [copying, setCopying] = useState(false);

  const load = async (w) => {
    try {
      const r = await api.getShiftWeek(w);
      setData(r);
      setShifts(r.schedule?.shifts || []);
      setPublished(!!r.schedule?.published);
      setDirty(false);
      setErr('');
    } catch (e) {
      setErr(e.message || 'Could not load the week.');
    }
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getShiftWeek(week);
        if (cancelled) return;
        setData(r);
        setShifts(r.schedule?.shifts || []);
        setPublished(!!r.schedule?.published);
        setDirty(false);
        setErr('');
      } catch (e) {
        if (!cancelled) setErr(e.message || 'Could not load the week.');
      }
    })();
    return () => { cancelled = true; };
  }, [week]);

  const dates = useMemo(() => weekDays(week), [week]);
  const today = todayStr();
  const dayInWeek = dates.includes(day) ? day : (dates.includes(today) ? today : dates[0]);
  const goWeek = (w) => { setWeek(w); setDay(w === mondayOf(today) ? today : w); };   // today when it's in that week, else its Monday
  const users = data?.users || [];
  const avail = data?.availability || {};

  const shiftsAt = (userId, date) => shifts.filter((s) => s.userId === userId && s.date === date);
  const hoursFor = (userId) => shifts.filter((s) => s.userId === userId).reduce((n, s) => n + hoursBetween(s.from, s.to), 0);
  const dayTotals = (date) => {
    const ds = shifts.filter((s) => s.date === date);
    return { people: new Set(ds.map((s) => s.userId)).size, hours: ds.reduce((n, s) => n + hoursBetween(s.from, s.to), 0) };
  };
  const weekHours = shifts.reduce((n, s) => n + hoursBetween(s.from, s.to), 0);
  const replied = users.filter((u) => avail[u.id]?.days && Object.keys(avail[u.id].days).length).length;

  const change = (next) => { setShifts(next); setDirty(true); };
  const newId = () => `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const save = async (publishNow) => {
    setSaving(true); setErr('');
    try {
      const r = await api.saveShiftSchedule({ week, shifts, published: publishNow === undefined ? published : publishNow });
      setShifts(r.schedule.shifts);
      setPublished(!!r.schedule.published);
      setDirty(false);
      showToast?.(r.schedule.published ? 'Schedule published — the team can see their shifts' : 'Draft saved');
    } catch (e) {
      setErr(e.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const copyLastWeek = async () => {
    setCopying(true);
    try {
      const prev = await api.getShiftWeek(addDays(week, -7));
      const copied = (prev.schedule?.shifts || []).map((s) => ({ ...s, id: newId(), date: addDays(s.date, 7) }));
      if (!copied.length) { showToast?.('Last week has no shifts to copy', 'error'); return; }
      change([...shifts.filter((s) => !copied.some((c) => c.userId === s.userId && c.date === s.date)), ...copied]);
      showToast?.(`${copied.length} shift${copied.length === 1 ? '' : 's'} copied from last week`);
    } catch (e) {
      showToast?.(e.message || 'Could not read last week', 'error');
    } finally {
      setCopying(false);
    }
  };

  const availLabel = (a) => {
    if (!a) return 'no reply';
    const hs = dayHours(a);
    if (!hs.length) return 'No';
    return `${a.status === 'maybe' ? 'Maybe' : 'Yes'} ${fmtRuns(hs)}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => goWeek(addDays(week, -7))} className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50" aria-label="Previous week"><ChevronLeft className="w-4 h-4" /></button>
          <button type="button" onClick={() => goWeek(mondayOf(todayStr()))} className="px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 text-sm">This week</button>
          <button type="button" onClick={() => goWeek(addDays(week, 7))} className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50" aria-label="Next week"><ChevronRight className="w-4 h-4" /></button>
        </div>
        <h2 className="text-lg font-semibold text-gray-900">{weekLabel(week)}</h2>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${published ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}>{published ? 'Published' : 'Draft'}</span>
        {dirty && <span className="text-xs text-amber-700">unsaved changes</span>}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            <button type="button" onClick={() => setView('day')} className={`inline-flex items-center gap-1.5 px-3 py-2 ${view === 'day' ? 'bg-gray-900 text-white' : 'hover:bg-gray-50 text-gray-700'}`}><Clock className="w-4 h-4" /> By hour</button>
            <button type="button" onClick={() => setView('week')} className={`inline-flex items-center gap-1.5 px-3 py-2 border-l border-gray-300 ${view === 'week' ? 'bg-gray-900 text-white' : 'hover:bg-gray-50 text-gray-700'}`}><LayoutGrid className="w-4 h-4" /> Week</button>
          </div>
          <button type="button" onClick={() => setMyAvailOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"><CalendarDays className="w-4 h-4" /> My availability</button>
          <button type="button" onClick={copyLastWeek} disabled={copying} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">{copying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />} Copy last week</button>
          <button type="button" onClick={() => save()} disabled={saving || !dirty} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"><Check className="w-4 h-4" /> Save draft</button>
          {published ? (
            <button type="button" onClick={() => save(false)} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-amber-300 text-amber-800 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50"><Undo2 className="w-4 h-4" /> Unpublish</button>
          ) : (
            <button type="button" onClick={() => save(true)} disabled={saving || shifts.length === 0} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Publish</button>
          )}
        </div>
      </div>

      {err && <div className="flex items-center gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg"><AlertCircle className="w-4 h-4 shrink-0" /> {err}</div>}
      {!data && !err && <div className="flex items-center gap-2 text-sm text-gray-500 py-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}

      {data && (
        <>
          <div className="flex items-center gap-3 text-xs text-gray-600 flex-wrap">
            <span><b className="text-gray-900">{replied}</b> of {users.length} replied</span>
            <span>·</span>
            <span><b className="text-gray-900">{shifts.length}</b> shift{shifts.length === 1 ? '' : 's'} · <b className="text-gray-900">{fmtHours(weekHours)}</b> planned</span>
            <span className="ml-auto">{view === 'day' ? 'Drag across the hours to plan a shift · tap a block to adjust it' : 'Click a cell to plan a shift'} · <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-200 align-middle" /> yes · <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-200 align-middle" /> maybe · <span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-200 align-middle" /> no</span>
          </div>
          {view === 'day' && (
            <>
              <div className="flex gap-1.5 flex-wrap">
                {dates.map((d) => {
                  const t = dayTotals(d);
                  const can = users.filter((u) => dayHours(avail[u.id]?.days?.[d]).length > 0).length;
                  const on = d === dayInWeek;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDay(d)}
                      className={`px-3 py-1.5 rounded-lg border text-left ${on ? 'bg-gray-900 text-white border-gray-900' : 'bg-white border-gray-300 text-gray-800 hover:bg-gray-50'}`}
                    >
                      <div className={`text-sm font-semibold ${d === today && !on ? 'text-emerald-700' : ''}`}>{dayName(d)} <span className="font-normal">{shortDate(d)}</span></div>
                      <div className={`text-[11px] ${on ? 'text-gray-300' : 'text-gray-500'}`}>{can} can · {t.people ? `${t.people} on · ${fmtHours(t.hours)}` : 'nothing planned'}</div>
                    </button>
                  );
                })}
              </div>
              <DayPlanner
                date={dayInWeek}
                users={users}
                availability={avail}
                shifts={shifts.filter((s) => s.date === dayInWeek)}
                today={today}
                currentUserId={currentUser?.id}
                onCreate={(userId, date, from, to) => change([...shifts, { id: newId(), userId, date, from, to, label: '', note: '' }])}
                onEdit={(userId, date) => setEditing({ userId, date })}
              />
            </>
          )}
          {view === 'week' && (
          <div className="overflow-x-auto border border-gray-200 rounded-xl bg-white">
            <table className="min-w-[900px] w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left px-3 py-2 font-semibold text-gray-700 w-40">Team</th>
                  {dates.map((d) => (
                    <th key={d} className={`px-2 py-2 font-semibold text-center ${d === today ? 'text-emerald-700' : 'text-gray-700'}`}>
                      <div>{dayName(d)}</div>
                      <div className="text-xs font-normal text-gray-500">{shortDate(d)}</div>
                    </th>
                  ))}
                  <th className="px-2 py-2 font-semibold text-gray-700 text-right w-16">Hours</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const ua = avail[u.id];
                  return (
                    <tr key={u.id} className="border-t border-gray-100 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900">{u.displayName}{u.id === currentUser?.id ? ' (you)' : ''}</div>
                        <div className="text-xs text-gray-500">{u.role === 'admin' ? 'Admin' : 'Team member'}</div>
                        {ua?.note && <div className="text-xs text-amber-800 mt-1 italic" title={ua.note}>“{ua.note.length > 60 ? `${ua.note.slice(0, 60)}…` : ua.note}”</div>}
                      </td>
                      {dates.map((d) => {
                        const a = ua?.days?.[d];
                        const cell = shiftsAt(u.id, d);
                        const style = AVAIL_STYLE[!a ? 'none' : dayHours(a).length ? (a.status === 'maybe' ? 'maybe' : 'yes') : 'no'];
                        return (
                          <td key={d} className="px-1.5 py-1.5">
                            <button
                              type="button"
                              onClick={() => setEditing({ userId: u.id, date: d })}
                              className={`w-full min-h-[3.75rem] rounded-lg border text-left px-2 py-1.5 hover:ring-2 hover:ring-emerald-300 ${style}`}
                              title={a?.note || (a ? availLabel(a) : 'No reply yet')}
                            >
                              <div className="text-[11px] leading-tight truncate">{availLabel(a)}</div>
                              {cell.map((s) => (
                                <div key={s.id} className="mt-1 text-xs font-semibold text-gray-900 bg-white/80 rounded px-1.5 py-0.5 border border-gray-200 truncate">
                                  {fmtRange(s.from, s.to)}{s.label ? ` · ${s.label}` : ''}
                                </div>
                              ))}
                            </button>
                          </td>
                        );
                      })}
                      <td className="px-2 py-2 text-right font-semibold text-gray-900 tabular-nums">{fmtHours(hoursFor(u.id))}</td>
                    </tr>
                  );
                })}
                {users.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500">No team members yet — add them in Users.</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200 bg-gray-50 text-xs text-gray-600">
                  <td className="px-3 py-2 font-semibold">On shift</td>
                  {dates.map((d) => { const t = dayTotals(d); return <td key={d} className="px-2 py-2 text-center">{t.people ? `${t.people} · ${fmtHours(t.hours)}` : '—'}</td>; })}
                  <td className="px-2 py-2 text-right font-semibold text-gray-900">{fmtHours(weekHours)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          )}
        </>
      )}

      {editing && data && (
        <ShiftEditor
          user={users.find((u) => u.id === editing.userId)}
          date={editing.date}
          availability={avail[editing.userId]?.days?.[editing.date]}
          shifts={shiftsAt(editing.userId, editing.date)}
          onChange={(next) => change([...shifts.filter((s) => !(s.userId === editing.userId && s.date === editing.date)), ...next])}
          onClose={() => setEditing(null)}
        />
      )}
      {myAvailOpen && <AvailabilityModal onClose={() => setMyAvailOpen(false)} onSaved={() => load(week)} />}
    </div>
  );
}

// The shifts of one person on one day: edit times and label, add a second
// one (split shift), remove. Changes land in the draft; Save/Publish commit.
function ShiftEditor({ user, date, availability, shifts, onChange, onClose }) {
  const [rows, setRows] = useState(() => (shifts.length ? shifts : []));
  const set = (i, patch) => setRows((r) => r.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const add = (from = DEFAULT_FROM, to = DEFAULT_TO) => setRows((r) => [...r, { id: `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, userId: user.id, date, from, to, label: '', note: '' }]);
  const canUse = dayHours(availability).length > 0;
  const apply = () => {
    for (const s of rows) {
      if (!s.from || !s.to || s.to <= s.from) return;
    }
    onChange(rows);
    onClose();
  };
  return (
    <Modal title={`${user?.displayName || 'Shift'} · ${dayName(date)} ${shortDate(date)}`} onClose={onClose} size="md">
      <div className="space-y-3">
        <div className={`text-sm rounded-lg px-3 py-2 border ${AVAIL_STYLE[!availability ? 'none' : dayHours(availability).length ? 'yes' : 'no']}`}>
          {availability
            ? <>{dayHours(availability).length ? <>Can work <b>{fmtRuns(dayHours(availability))}</b></> : <b>Not available</b>}{availability.note ? ` — ${availability.note}` : ''}</>
            : 'No availability submitted for this day.'}
          {canUse && (
            <button type="button" onClick={() => { const runs = hourRuns(dayHours(availability)); setRows(runs.map(([from, to]) => ({ id: `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, userId: user.id, date, from, to, label: '', note: '' }))); }} className="ml-2 text-xs font-semibold underline">Use their hours</button>
          )}
        </div>
        {rows.length === 0 && <div className="text-sm text-gray-500">No shift planned. Add one below.</div>}
        {rows.map((s, i) => (
          <div key={s.id} className="border border-gray-200 rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <input type="time" value={s.from} onChange={(e) => set(i, { from: e.target.value })} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm" aria-label="From" />
              <span className="text-gray-400">–</span>
              <input type="time" value={s.to} onChange={(e) => set(i, { to: e.target.value })} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm" aria-label="To" />
              <span className="text-xs text-gray-500">{fmtHours(hoursBetween(s.from, s.to))}</span>
              <button type="button" onClick={() => setRows((r) => r.filter((_, j) => j !== i))} className="ml-auto p-1.5 rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-700" aria-label="Remove shift"><Trash2 className="w-4 h-4" /></button>
            </div>
            <div className="flex gap-2">
              <input type="text" value={s.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="Label (Packing, Live, Greenhouse…)" className="flex-1 border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm" />
              <input type="text" value={s.note} onChange={(e) => set(i, { note: e.target.value })} placeholder="Note" className="flex-1 border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm" />
            </div>
            {s.to <= s.from && <div className="text-xs text-red-700">The shift must end after it starts.</div>}
          </div>
        ))}
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => add()} className="inline-flex items-center gap-1.5 text-sm text-gray-700 border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50"><Plus className="w-4 h-4" /> Add shift</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"><X className="w-4 h-4" /> Cancel</button>
            <button type="button" onClick={apply} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"><Check className="w-4 h-4" /> Done</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
