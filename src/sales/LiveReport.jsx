import { useEffect, useMemo, useState } from 'react';
import { Loader2, Radio, ChevronDown } from 'lucide-react';
import { api } from '../api.js';
import { computeLiveMetrics, BUCKET_MS } from './liveMetrics.js';

// Post-live report for one sale event, from the show the BAE live widget
// recorded into it (api/settings.js archiveLiveShow): pace of selling, how
// gross built over the show, the audience over time, and every lot sold.
//
// Charts are hand-rolled SVG on a light surface: one series per chart (no
// dual axes), thin marks, recessive grid, crosshair + tooltip on hover, the
// last value direct-labelled. Colors are the first three categorical slots
// of the validated reference palette (validate_palette.js, light mode).

const C_LOTS = '#2a78d6';      // lots sold (pace bars)
const C_GROSS = '#1baf7a';     // gross over time
const C_VIEWERS = '#eb6834';   // audience over time

const fmtMoney = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const fmtInt = (v) => (v == null ? '—' : Number(v).toLocaleString());
const fmtClock = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const fmtDur = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export function LiveReport({ saleId, sale, showBuyers = true, compact = false }) {
  const [state, setState] = useState({ loading: true, report: null, live: false, updatedAt: null, error: null });
  useEffect(() => {
    let alive = true;
    api.getLiveShowReport(saleId)
      .then(r => { if (alive) setState({ loading: false, report: r?.report || null, live: !!r?.live, updatedAt: r?.updatedAt || null, error: null }); })
      .catch(e => { if (alive) setState({ loading: false, report: null, live: false, updatedAt: null, error: e.message || 'Could not load the live report' }); });
    return () => { alive = false; };
  }, [saleId]);
  const m = useMemo(() => (state.report ? computeLiveMetrics(state.report) : null), [state.report]);

  if (state.loading) return <div className="py-12 text-center text-gray-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading the live report…</div>;
  if (state.error) return <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{state.error}</div>;
  if (!state.report || !m) {
    return (
      <div className="py-10 text-center text-sm text-gray-500">
        No live was recorded for this sale. The BAE live widget records the show into the sale event while it runs on the Palmstreet dashboard.
      </div>
    );
  }
  const r = state.report;
  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold text-gray-900 truncate">{r.title || sale?.name || 'Live'}</div>
          <div className="text-xs text-gray-500">
            {fmtClock(m.t0)} – {fmtClock(m.tEnd)} · {fmtDur(m.durationMs)}{r.streaming ? ` · ${r.streaming}` : ''}
          </div>
        </div>
        {state.live ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700">
            <Radio className="w-3.5 h-3.5 animate-pulse" /> LIVE · updating
          </span>
        ) : r.closedAt ? (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600" title={`Sale event closed ${r.closedBy === 'auto' ? 'automatically ' : ''}at ${fmtClock(r.closedAt)}`}>
            Ended {fmtClock(r.endedAt || r.lastSeenAt)}{r.closedBy === 'auto' ? ' · auto-closed' : ''}
          </span>
        ) : null}
      </div>

      <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}>
        <Tile label="Lots sold" value={fmtInt(m.sold.length)} sub={m.orders != null ? `${fmtInt(m.orders)} orders on the dashboard` : null} />
        <Tile label="Gross" value={fmtMoney(m.gross)} sub={m.avgPrice != null ? `avg ${fmtMoney(m.avgPrice)} per lot` : null} />
        <Tile label="Pace" value={m.lotsPerHour != null ? `${m.lotsPerHour.toFixed(1)}/hr` : '—'} sub={m.avgGapMs != null ? `a sale every ${fmtDur(m.avgGapMs)}` : 'lots per hour'} />
        <Tile label="Peak viewers" value={fmtInt(m.peakViewers)} sub={m.avgViewers != null ? `avg ${fmtInt(Math.round(m.avgViewers))} · ${fmtInt(m.joins)} joins` : `${fmtInt(m.joins)} joins`} />
      </div>

      {(m.firstSaleMs != null || m.best30 || m.maxGapMs) && (
        <div className="text-xs text-gray-600 bg-gray-50 rounded-xl px-3 py-2 flex flex-wrap gap-x-4 gap-y-1">
          {m.firstSaleMs != null && <span>First sale <b className="text-gray-900">{fmtDur(m.firstSaleMs)}</b> in</span>}
          {m.best30 && <span>Best 30 min <b className="text-gray-900">{m.best30.count} lots</b> from {fmtClock(m.best30.start)}</span>}
          {m.maxGapMs > 0 && <span>Longest lull <b className="text-gray-900">{fmtDur(m.maxGapMs)}</b>{m.maxGapAt ? ` ending ${fmtClock(m.maxGapAt)}` : ''}</span>}
          {m.bids > 0 && <span><b className="text-gray-900">{fmtInt(m.bids)}</b> bids seen</span>}
        </div>
      )}

      <ChartCard title="Selling pace" sub="Lots sold per 15 minutes">
        <PaceBars buckets={m.buckets} t0={m.t0} t1={m.t1} color={C_LOTS} compact={compact} />
      </ChartCard>
      <ChartCard title="Gross over the show" sub="Running total of sold lots">
        <LineChart points={m.grossPts} t0={m.t0} t1={m.t1} color={C_GROSS} format={fmtMoney} label="gross" area compact={compact} />
      </ChartCard>
      <ChartCard title="Audience" sub={m.viewerPts.length ? 'Viewers in the room, once a minute' : null}>
        {m.viewerPts.length
          ? <LineChart points={m.viewerPts} t0={m.t0} t1={m.t1} color={C_VIEWERS} format={fmtInt} label="viewers" compact={compact} />
          : <div className="h-24 flex items-center justify-center text-xs text-gray-400 text-center px-4">Viewer count wasn't captured for this show. Set the viewer-count pattern in the extension options to record it.</div>}
      </ChartCard>

      <SoldTable sold={m.sold} showBuyers={showBuyers} />
    </div>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div className="bg-gray-50 rounded-xl px-3 py-2 min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 truncate">{label}</div>
      <div className="text-xl font-bold text-gray-900 tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-gray-500 truncate">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, sub, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-3 pt-2.5 pb-2">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

// Chart box. The SVG scales to its container, so on a phone (compact) the
// viewBox is narrower — otherwise 11px axis text shrinks to half size.
const DIMS = {
  wide: { W: 720, H: 200, PL: 44, PR: 12, PT: 12, PB: 26 },
  compact: { W: 380, H: 170, PL: 40, PR: 10, PT: 12, PB: 24 },
};
const niceStep = (max, n = 4) => {
  const raw = max / n || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const c = raw / p;
  const s = c <= 1 ? 1 : c <= 2 ? 2 : c <= 5 ? 5 : 10;
  return s * p;
};
function xTicksFor(t0, t1) {
  return [0, 0.25, 0.5, 0.75, 1].map(f => t0 + f * (t1 - t0));
}

// Single-series line (optionally filled) with crosshair + tooltip.
function LineChart({ points, t0, t1, color, format, label, area = false, compact = false }) {
  const [hover, setHover] = useState(null);
  const { W, H, PL, PR, PT, PB } = compact ? DIMS.compact : DIMS.wide;
  const pts = (points || []).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (pts.length < 2 || t0 == null || t1 == null) {
    return <div className="h-24 flex items-center justify-center text-xs text-gray-400">Not enough data yet.</div>;
  }
  const vMax = Math.max(...pts.map(p => p.v));
  const step = niceStep(vMax || 1);
  const yMax = Math.max(step, Math.ceil((vMax || 1) / step) * step);
  const x = (t) => PL + ((t - t0) / (t1 - t0)) * (W - PL - PR);
  const y = (v) => H - PB - (v / yMax) * (H - PT - PB);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const areaPath = `${path} L${x(pts[pts.length - 1].t).toFixed(1)},${y(0).toFixed(1)} L${x(pts[0].t).toFixed(1)},${y(0).toFixed(1)} Z`;
  const yTicks = []; for (let v = 0; v <= yMax; v += step) yTicks.push(v);
  const last = pts[pts.length - 1];
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - PL) / (W - PL - PR)) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHover(best);
  };
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={`${label} over the show`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="#e5e7eb" strokeWidth="1" />
            <text x={PL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#6b7280">{format(v)}</text>
          </g>
        ))}
        {xTicksFor(t0, t1).map((t, i, arr) => (
          <text key={t} x={x(t)} y={H - PB + 16} fontSize="11" fill="#6b7280"
            textAnchor={i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'}>{fmtClock(t)}</text>
        ))}
        {area && <path d={areaPath} fill={color} opacity="0.12" />}
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last.t)} cy={y(last.v)} r="4" fill={color} stroke="#fff" strokeWidth="2" />
        <text x={Math.min(x(last.t) + 8, W - PR - 60)} y={y(last.v) - 8} fontSize="12" fontWeight="600" fill="#111827">{format(last.v)}</text>
        {hover && (
          <g>
            <line x1={x(hover.t)} x2={x(hover.t)} y1={PT} y2={H - PB} stroke="#9ca3af" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={x(hover.t)} cy={y(hover.v)} r="5" fill={color} stroke="#fff" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover && (
        <div className="absolute pointer-events-none bg-gray-900 text-white text-xs rounded-lg px-2.5 py-1.5 shadow"
          style={{ left: `${Math.min(88, Math.max(4, (x(hover.t) / W) * 100))}%`, top: 4, transform: 'translateX(-50%)' }}>
          <div className="text-gray-300">{fmtClock(hover.t)}</div>
          <div className="font-semibold">{format(hover.v)} {label}</div>
        </div>
      )}
    </div>
  );
}

// Lots per bucket. Rounded data-ends, 2px surface gaps, only the top bucket
// direct-labelled, per-bar hover tooltip.
function PaceBars({ buckets, t0, t1, color, compact = false }) {
  const [hover, setHover] = useState(null);
  const { W, H, PL, PR, PT, PB } = compact ? DIMS.compact : DIMS.wide;
  if (!buckets || buckets.length === 0 || t0 == null || t1 == null) {
    return <div className="h-24 flex items-center justify-center text-xs text-gray-400">Not enough data yet.</div>;
  }
  const max = Math.max(1, ...buckets.map(b => b.count));
  const step = niceStep(max, 3);
  const yMax = Math.max(step, Math.ceil(max / step) * step);
  const x = (t) => PL + ((t - t0) / (t1 - t0)) * (W - PL - PR);
  const y = (v) => H - PB - (v / yMax) * (H - PT - PB);
  const bw = Math.max(2, (W - PL - PR) / buckets.length - 2);
  const yTicks = []; for (let v = 0; v <= yMax; v += step) yTicks.push(v);
  const top = buckets.reduce((b, c) => (c.count > (b?.count ?? -1) ? c : b), null);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Lots sold per 15 minutes">
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="#e5e7eb" strokeWidth="1" />
            <text x={PL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#6b7280">{v}</text>
          </g>
        ))}
        {xTicksFor(t0, t1).map((t, i, arr) => (
          <text key={t} x={x(t)} y={H - PB + 16} fontSize="11" fill="#6b7280"
            textAnchor={i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'}>{fmtClock(t)}</text>
        ))}
        {buckets.map((b, i) => {
          const bx = x(b.t) + 1, h = Math.max(0, y(0) - y(b.count));
          return (
            <g key={b.t} onMouseEnter={() => setHover({ ...b, i })} onMouseLeave={() => setHover(null)}>
              <rect x={bx - 2} y={PT} width={bw + 4} height={H - PT - PB} fill="transparent" />
              {b.count > 0 && <rect x={bx} y={y(b.count)} width={bw} height={h} rx="3" fill={color} opacity={hover && hover.i !== i ? 0.55 : 1} />}
              {b.count > 0 && top && top.t === b.t && !hover && (
                <text x={bx + bw / 2} y={y(b.count) - 6} textAnchor="middle" fontSize="12" fontWeight="600" fill="#111827">{b.count}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="absolute pointer-events-none bg-gray-900 text-white text-xs rounded-lg px-2.5 py-1.5 shadow"
          style={{ left: `${Math.min(88, Math.max(4, ((x(hover.t) + bw / 2) / W) * 100))}%`, top: 4, transform: 'translateX(-50%)' }}>
          <div className="text-gray-300">{fmtClock(hover.t)} – {fmtClock(hover.t + BUCKET_MS)}</div>
          <div className="font-semibold">{hover.count} lot{hover.count === 1 ? '' : 's'}{hover.gross ? ` · ${fmtMoney(hover.gross)}` : ''}</div>
        </div>
      )}
    </div>
  );
}

function SoldTable({ sold, showBuyers }) {
  const [open, setOpen] = useState(false);
  if (!sold.length) return null;
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full px-3 py-2.5 flex items-center justify-between text-sm font-semibold text-gray-900">
        <span>Every lot sold ({sold.length})</span>
        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-gray-100">
          <table className="w-full text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Time</th>
                <th className="text-left px-3 py-1.5 font-medium">Lot</th>
                <th className="text-left px-3 py-1.5 font-medium">Plant</th>
                <th className="text-right px-3 py-1.5 font-medium">Price</th>
                <th className="text-right px-3 py-1.5 font-medium">Bids</th>
                {showBuyers && <th className="text-left px-3 py-1.5 font-medium">Buyer</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sold.map((s, i) => (
                <tr key={`${s.lot}-${i}`}>
                  <td className="px-3 py-1.5 text-gray-500 tabular-nums">{fmtClock(s.t)}</td>
                  <td className="px-3 py-1.5 font-mono">{s.lot}</td>
                  <td className="px-3 py-1.5 text-gray-900">{s.title || ''}</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtMoney(s.price)}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500 tabular-nums">{Array.isArray(s.bids) ? s.bids.length : ''}</td>
                  {showBuyers && <td className="px-3 py-1.5 text-gray-600">{s.buyer ? `@${s.buyer}` : ''}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
