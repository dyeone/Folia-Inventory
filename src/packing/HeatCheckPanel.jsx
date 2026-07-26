import { useState } from 'react';
import { Thermometer, Loader2, Copy, RotateCcw } from 'lucide-react';
import { scanRecipientHeat } from './heatCheck.js';
import { copyText } from './labelPdf.js';

const THRESHOLD_F = 90;

// 'YYYY-MM-DD' as a LOCAL calendar day (the repo-wide convention — new
// Date('YYYY-MM-DD') reads UTC midnight, which shifts a day in US zones).
function dayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { weekday: 'short' });
}

// Shipping-tab heat check: scan every Ready recipient's 3-day forecast and
// list the ones peaking at or above 90°F, names/usernames copyable so the
// desk can message them about delaying or accepting the heat risk. Weather
// comes from key-less client-side APIs (see heatCheck.js); nothing here
// touches the server.
export function HeatCheckPanel({ boxes, showToast }) {
  const [phase, setPhase] = useState('idle'); // idle | running | done
  const [result, setResult] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);

  const run = async () => {
    if (phase === 'running') return;
    setPhase('running');
    try {
      const r = await scanRecipientHeat(boxes, THRESHOLD_F);
      setResult(r);
      setCheckedAt(new Date());
      setPhase('done');
    } catch (e) {
      showToast?.(`Heat check failed: ${e.message || 'network error'}`);
      setPhase(result ? 'done' : 'idle');
    }
  };

  const copyAll = (field, label) => {
    const list = (result?.hot || []).map(h => h[field]).filter(Boolean);
    if (!list.length) { showToast?.(`No ${label} to copy`); return; }
    copyText(list.join('\n'), showToast, `${list.length} ${label}`);
  };

  return (
    <div className="rounded-xl border border-orange-200 bg-orange-50/60 px-3.5 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Thermometer className="w-4 h-4 text-orange-600 shrink-0" />
        <span className="text-sm font-semibold text-gray-800">Heat check</span>
        <span className="text-xs text-gray-500">
          {phase === 'done' && result
            ? `${result.hot.length} of ${result.checked} recipients peak ≥ ${THRESHOLD_F}°F in the next 3 days${result.failed.length ? ` · ${result.failed.length} unchecked` : ''} · ${checkedAt?.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
            : `forecast the next 3 days for every Ready recipient (${boxes.length} ${boxes.length === 1 ? 'box' : 'boxes'})`}
        </span>
        <button
          type="button"
          onClick={run}
          disabled={phase === 'running' || boxes.length === 0}
          className="ml-auto text-xs font-medium px-2.5 py-1.5 rounded-md border border-orange-300 text-orange-700 bg-white hover:bg-orange-100 active:bg-orange-200 disabled:opacity-50 flex items-center gap-1"
        >
          {phase === 'running'
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…</>
            : phase === 'done'
              ? <><RotateCcw className="w-3.5 h-3.5" /> Re-check</>
              : <><Thermometer className="w-3.5 h-3.5" /> Check weather</>}
        </button>
      </div>

      {phase === 'done' && result && (
        result.hot.length === 0 ? (
          <div className="mt-2 text-sm text-emerald-700 font-medium">
            No recipients above {THRESHOLD_F}°F in the next 3 days — clear to ship. 🌤
          </div>
        ) : (
          <div className="mt-2.5">
            <div className="flex items-center gap-2 mb-2">
              <button
                type="button"
                onClick={() => copyAll('buyer', 'names')}
                className="text-xs font-medium px-2 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 flex items-center gap-1"
              >
                <Copy className="w-3 h-3" /> Copy all names
              </button>
              <button
                type="button"
                onClick={() => copyAll('buyerUsername', 'usernames')}
                className="text-xs font-medium px-2 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 flex items-center gap-1"
              >
                <Copy className="w-3 h-3" /> Copy all @usernames
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {result.hot.map(h => (
                <div
                  key={`${h.buyer}|${h.zip}`}
                  className="bg-white rounded-lg border border-orange-200 px-2.5 py-2 flex items-center gap-2 text-sm"
                >
                  <span
                    className={`shrink-0 min-w-[3.2rem] text-center font-extrabold tabular-nums px-1.5 py-0.5 rounded-md text-white ${
                      h.maxTemp >= 100 ? 'bg-red-700' : h.maxTemp >= 95 ? 'bg-red-500' : 'bg-orange-500'
                    }`}
                    title={`3-day peak${h.peakDay ? ` on ${h.peakDay}` : ''}`}
                  >
                    {h.maxTemp}°F
                  </span>
                  <div className="flex-1 min-w-0">
                    <button
                      type="button"
                      onClick={() => copyText(h.buyer, showToast, 'name')}
                      title={`Copy name: ${h.buyer}`}
                      className="max-w-full font-semibold text-gray-900 truncate hover:text-orange-700 flex items-center gap-1"
                    >
                      <span className="truncate">{h.buyer}</span>
                      <Copy className="w-3 h-3 text-gray-400 shrink-0" />
                    </button>
                    <div className="text-xs text-gray-500 truncate">
                      {h.buyerUsername && (
                        <button
                          type="button"
                          onClick={() => copyText(h.buyerUsername, showToast, 'username')}
                          title={`Copy username: ${h.buyerUsername}`}
                          className="hover:text-orange-700"
                        >
                          @{h.buyerUsername}
                        </button>
                      )}
                      {h.buyerUsername ? ' · ' : ''}{h.place} {h.zip}
                      {h.peakDay ? ` · peaks ${dayLabel(h.peakDay)}` : ''}
                      {' · '}{h.boxCodes.join(', ')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {result.failed.length > 0 && (
              <div className="mt-1.5 text-xs text-gray-500">
                Couldn’t check: {result.failed.map(f => `${f.buyer}${f.zip ? ` (${f.zip})` : ' (no zip)'}`).join(', ')}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}
