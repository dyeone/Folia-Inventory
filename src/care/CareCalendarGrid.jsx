import { Check, Pencil, Trash2 } from 'lucide-react';
import { CARE_TYPES, careType, buildWeeks, careProgress, todayYmd } from './careHelpers.js';

// One day cell — a colored care task with a check-off box, or a plain
// "Observe only" day. Today gets a red ring (matching the screenshot).
function DayCell({ day, isToday, onToggle }) {
  const t = day.task;
  const type = t ? careType(t.type) : null;
  const dayNum = day.date.getDate();
  const mon = day.date.toLocaleDateString(undefined, { month: 'short' });

  return (
    <div
      className={`relative min-h-[92px] rounded-lg border p-2 text-left ${
        type ? `${type.cellBg} border-gray-200` : 'bg-white border-gray-200'
      } ${isToday ? 'ring-2 ring-red-500' : ''}`}
    >
      {type && <span className={`absolute left-0 top-2 bottom-2 w-1 rounded-full ${type.accent}`} />}

      <div className="flex items-start justify-between gap-1 pl-1.5">
        <div className="text-xs">
          <span className="font-semibold text-gray-700 tabular-nums">{dayNum}</span>{' '}
          <span className="text-gray-400">{mon}</span>
        </div>
        <div className="flex items-center gap-1">
          {isToday && <span className="text-[10px] font-bold text-red-600 uppercase">Today</span>}
          {t && (
            <button
              type="button"
              onClick={() => onToggle(t)}
              aria-label={t.done ? 'Mark not done' : 'Mark done'}
              className={`w-5 h-5 shrink-0 rounded border flex items-center justify-center transition ${
                t.done ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-gray-300 text-transparent hover:border-emerald-500'
              }`}
            >
              <Check className="w-3 h-3" strokeWidth={3} />
            </button>
          )}
        </div>
      </div>

      {t ? (
        <div className="mt-1 pl-1.5">
          <div className={`text-[10px] font-bold uppercase tracking-wide ${type?.text}`}>{type?.chip}</div>
          <div className={`text-sm font-semibold leading-tight ${t.done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
            {t.title}
          </div>
          {t.detail && <div className="text-xs text-gray-500 leading-tight mt-0.5">{t.detail}</div>}
        </div>
      ) : (
        <div className="mt-2 pl-1.5 text-xs text-gray-400">Observe only</div>
      )}
    </div>
  );
}

// Full care calendar: branded header band, legend, and the week×day grid.
// Horizontally scrolls on small screens to keep the layout intact.
export function CareCalendarGrid({ calendar, onToggleTask, onEdit, onDelete, isAdmin }) {
  const { weeks, weekdays } = buildWeeks(calendar);
  const today = todayYmd();
  const { done, total } = careProgress(calendar);
  const rangeLabel = weeks.length
    ? `${weeks[0].range.split(' – ')[0]} – ${weeks[weeks.length - 1].range.split(' – ')[1]}`
    : '';

  return (
    <div className="bg-[#faf8ef] rounded-2xl border border-gray-200 overflow-hidden">
      {/* Branded header band */}
      <div className="bg-emerald-900 text-white px-5 py-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 className="text-2xl font-bold tracking-tight">{calendar.title}</h2>
            {calendar.subtitle && <span className="text-emerald-100/90 text-sm">{calendar.subtitle}</span>}
          </div>
          {calendar.notes && <p className="text-emerald-100/80 text-xs mt-1.5">{calendar.notes}</p>}
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold whitespace-nowrap">{rangeLabel}</div>
          <div className="text-emerald-100/80 text-xs mt-0.5 tabular-nums">{done}/{total} done</div>
          {isAdmin && (
            <div className="flex items-center justify-end gap-1 mt-2">
              <button onClick={onEdit} aria-label="Edit calendar" className="p-1.5 rounded-lg text-emerald-100 hover:bg-white/10">
                <Pencil className="w-4 h-4" />
              </button>
              <button onClick={onDelete} aria-label="Delete calendar" className="p-1.5 rounded-lg text-emerald-100 hover:bg-red-500/30">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="px-5 py-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-gray-200">
        {CARE_TYPES.map(t => (
          <span key={t.id} className="flex items-center gap-1.5 text-sm text-gray-700">
            <span className={`w-2.5 h-2.5 rounded-full ${t.dot}`} /> {t.label}
          </span>
        ))}
        {calendar.dailyNote && (
          <span className="text-sm text-gray-500 sm:ml-auto">{calendar.dailyNote}</span>
        )}
      </div>

      {/* Week × day grid (scrolls horizontally on narrow screens) */}
      <div className="overflow-x-auto p-3 sm:p-4">
        <div className="min-w-[760px]">
          {/* Weekday header */}
          <div className="grid grid-cols-[110px_repeat(7,minmax(0,1fr))] gap-2 mb-2">
            <div />
            {weekdays.map((d, i) => (
              <div key={i} className="text-center text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{d}</div>
            ))}
          </div>

          {weeks.map(week => (
            <div key={week.index} className="grid grid-cols-[110px_repeat(7,minmax(0,1fr))] gap-2 mb-2">
              <div className="flex flex-col justify-center pr-2">
                <div className="text-sm font-bold text-gray-900 uppercase">Week {week.index + 1}</div>
                <div className="text-sm text-emerald-700 font-medium">{week.label}</div>
                <div className="text-[11px] text-gray-400 mt-1">{week.range}</div>
              </div>
              {week.days.map(day => (
                <DayCell
                  key={day.key}
                  day={day}
                  isToday={day.key === today}
                  onToggle={(task) => onToggleTask(calendar.id, task)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
