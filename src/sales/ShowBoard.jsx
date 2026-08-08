import { useEffect, useMemo, useRef, useState } from 'react';
import { Crown, Maximize, Star, X } from 'lucide-react';
import { api } from '../api.js';

// Streamer-facing show board — a full-screen dark dashboard for a second
// monitor during a live. Reached via #show-board=<brand> (mirrors the
// audience FollowerBoard route). Data comes from the Chrome extension's
// dashboard scraper (live_show blob, polled every 3s):
//
//   · price trend of the show — every sold lot plotted over show time with a
//     running average (hand-rolled SVG; palette validated for the dark
//     surface: sold #3987e5, average #199e70)
//   · activity feed — sales, bids, and room joins, newest first, each
//     username checked against SHIPPING HISTORY (this brand's items by
//     buyerUsername) and badged: 👑 VIP / ⭐ repeat, with lifetime $ + boxes
//
// History is one items fetch on mount — a live doesn't change history.

const POLL_MS = 3_000;
const SHOW_STALE_MS = 12 * 60 * 60 * 1000;  // keep the last show on screen half a day
const LIVE_FRESH_MS = 20_000;
const FEED_MAX = 60;

// VIP tiers from lifetime shipping history. Spend counts sold/shipped/
// delivered items (salePrice, else listingPrice); boxes = distinct shipments.
const VIP_SPEND = 500;
const VIP_BOXES = 5;
const REPEAT_SPEND = 100;
const REPEAT_BOXES = 2;

const CHART_SOLD = '#3987e5';   // categorical slot 1 (dark-stepped)
const CHART_AVG = '#199e70';    // categorical slot 3 (dark-stepped)

const fmtMoney = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString()}`);
const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function buyerTier(stats) {
  if (!stats) return null;
  if (stats.spent >= VIP_SPEND || stats.boxes >= VIP_BOXES) return 'vip';
  if (stats.spent >= REPEAT_SPEND || stats.boxes >= REPEAT_BOXES) return 'repeat';
  return null;
}

function BuyerBadge({ stats }) {
  const tier = buyerTier(stats);
  if (!tier) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold flex-shrink-0 ${
        tier === 'vip' ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300'
      }`}
      title={`${stats.items} items · ${stats.boxes} boxes · ${fmtMoney(stats.spent)} lifetime`}
    >
      {tier === 'vip' ? <Crown className="w-3 h-3" /> : <Star className="w-3 h-3" />}
      {fmtMoney(Math.round(stats.spent))} · {stats.boxes} bx
    </span>
  );
}

// ── Price trend chart ──────────────────────────────────────────────────
// Scatter of sold lots over show time + a running-average line. One axis,
// two series (legend top-right), recessive grid, per-dot hover tooltip.
function TrendChart({ sold, startedAt }) {
  const [hover, setHover] = useState(null); // { x, y, s }
  const W = 900, H = 320, PAD_L = 56, PAD_R = 16, PAD_T = 18, PAD_B = 34;

  const pts = useMemo(() => {
    const rows = (sold || [])
      .filter(s => s.price != null && s.at)
      .map(s => ({ ...s, t: new Date(s.at).getTime() }))
      .sort((a, b) => a.t - b.t);
    const out = [];
    let sum = 0;
    for (let i = 0; i < rows.length; i++) {
      sum += Number(rows[i].price) || 0;
      out.push({ ...rows[i], avg: sum / (i + 1) });
    }
    return out;
  }, [sold]);

  if (pts.length === 0) {
    return (
      <div className="h-[320px] flex items-center justify-center text-gray-600 text-lg">
        Sales appear here as lots close.
      </div>
    );
  }

  const t0 = startedAt ? new Date(startedAt).getTime() : pts[0].t;
  const t1 = Math.max(pts[pts.length - 1].t, t0 + 10 * 60 * 1000);
  const yMax = Math.max(...pts.map(p => p.price)) * 1.15 || 10;
  const x = (t) => PAD_L + ((t - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);
  const y = (v) => H - PAD_B - (v / yMax) * (H - PAD_T - PAD_B);

  // ~4 clean y ticks; time ticks at even fractions of the span.
  const yStep = Math.max(5, Math.ceil(yMax / 4 / 5) * 5);
  const yTicks = []; for (let v = 0; v <= yMax; v += yStep) yTicks.push(v);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => t0 + f * (t1 - t0));

  const soldPath = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const avgPath = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Sold price over show time">
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="#ffffff14" strokeWidth="1" />
            <text x={PAD_L - 8} y={y(v) + 4} textAnchor="end" fontSize="12" fill="#9ca3af">${v}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={t} x={x(t)} y={H - PAD_B + 18}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontSize="12" fill="#9ca3af"
          >
            {fmtClock(t)}
          </text>
        ))}
        {/* sold prices: thin connector + dots */}
        <path d={soldPath} fill="none" stroke={CHART_SOLD} strokeWidth="2" opacity="0.45" />
        {/* running average */}
        <path d={avgPath} fill="none" stroke={CHART_AVG} strokeWidth="2" />
        {/* direct label on the last avg point; flips to end-anchored near the
            right edge so it never clips out of the plot */}
        <text
          x={x(last.t) + 90 > W - PAD_R ? x(last.t) - 8 : x(last.t) + 8}
          y={y(last.avg) - 10}
          textAnchor={x(last.t) + 90 > W - PAD_R ? 'end' : 'start'}
          fontSize="12" fill="#c3c2b7"
        >
          avg {fmtMoney(Math.round(last.avg))}
        </text>
        {pts.map((p, i) => (
          <g key={`${p.lot}-${i}`}>
            <circle cx={x(p.t)} cy={y(p.price)} r="5" fill={CHART_SOLD} stroke="#030712" strokeWidth="2" />
            {/* oversized invisible hit target for hover */}
            <circle
              cx={x(p.t)} cy={y(p.price)} r="14" fill="transparent"
              onMouseEnter={() => setHover({ x: x(p.t) / W, y: y(p.price) / H, s: p })}
              onMouseLeave={() => setHover(null)}
            />
          </g>
        ))}
        {/* legend — two series, ink text with colored marks */}
        <g transform={`translate(${W - PAD_R - 210}, ${PAD_T})`} fontSize="12" fill="#c3c2b7">
          <circle cx="6" cy="0" r="5" fill={CHART_SOLD} />
          <text x="16" y="4">Sold price</text>
          <line x1="96" x2="120" y1="0" y2="0" stroke={CHART_AVG} strokeWidth="2" />
          <text x="126" y="4">Running avg</text>
        </g>
      </svg>
      {hover && (
        <div
          className="absolute z-10 pointer-events-none bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 shadow-xl"
          style={{
            left: `${Math.min(hover.x * 100, 78)}%`,
            top: `${Math.max(hover.y * 100 - 6, 2)}%`,
            transform: 'translateY(-100%)',
          }}
        >
          <div className="font-semibold">#{hover.s.lot} {hover.s.title || ''}</div>
          <div className="text-gray-400">
            {fmtMoney(hover.s.price)} · @{hover.s.buyer || '—'}
            {hover.s.bids?.length ? ` · ${hover.s.bids.length} bids` : ''} · {fmtClock(hover.s.t)}
          </div>
        </div>
      )}
    </div>
  );
}

export function ShowBoard({ brandId, brands = [], onSwitchBrand, onClose }) {
  const [payload, setPayload] = useState(null);   // { show, updatedAt }
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const poll = async () => {
      try {
        const r = await api.getLiveShow(brandId);
        // Freshness computed at poll time (render must stay pure); the 3s
        // poll keeps it current enough for the LIVE pill.
        const age = r?.updatedAt ? Date.now() - new Date(r.updatedAt).getTime() : Infinity;
        if (alive.current) { setPayload({ ...r, age }); setError(null); }
      } catch (e) {
        if (alive.current && !payload) setError(e.message || 'Could not load the show');
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    // Shipping history for VIP badges — once; a live doesn't change history.
    api.getItemsForBrand(brandId).then(rows => { if (alive.current) setItems(rows || []); }).catch(() => {});
    return () => { alive.current = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // buyerUsername (lowercase) → lifetime stats from shipping history.
  const buyerStats = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      const u = (it.buyerUsername || '').trim().toLowerCase();
      if (!u) continue;
      if (!['sold', 'shipped', 'delivered'].includes(it.status)) continue;
      let s = m.get(u);
      if (!s) { s = { spent: 0, items: 0, boxSet: new Set() }; m.set(u, s); }
      s.items += 1;
      s.spent += parseFloat(it.salePrice) || parseFloat(it.listingPrice) || 0;
      if (it.shipmentBoxId) s.boxSet.add(it.shipmentBoxId);
    }
    const out = new Map();
    for (const [u, s] of m) out.set(u, { spent: s.spent, items: s.items, boxes: s.boxSet.size });
    return out;
  }, [items]);
  const statsFor = (name) => buyerStats.get((name || '').trim().toLowerCase()) || null;

  const show = payload?.show;
  const age = payload?.age ?? Infinity;
  const isLive = age < LIVE_FRESH_MS;
  const hasShow = !!show && age < SHOW_STALE_MS;
  const sold = useMemo(
    () => (hasShow && Array.isArray(show?.sold) ? show.sold : []),
    [hasShow, show],
  );

  // Feed: sales + bids + joins interleaved, newest first.
  const feed = useMemo(() => {
    if (!hasShow) return [];
    const ev = [];
    for (const s of sold) ev.push({ type: 'sale', t: s.at, user: s.buyer, s });
    for (const b of (show.bidders || [])) ev.push({ type: 'bid', t: b.t, user: b.user, price: b.price });
    for (const j of (show.joins || [])) ev.push({ type: 'join', t: j.t, user: j.user });
    return ev
      .filter(e => e.t)
      .sort((a, b) => new Date(b.t) - new Date(a.t))
      .slice(0, FEED_MAX);
  }, [hasShow, sold, show]);

  const avg = sold.length ? sold.reduce((s, x) => s + (Number(x.price) || 0), 0) / sold.length : null;
  const vipInRoom = useMemo(() => {
    const seen = new Set();
    for (const e of feed) {
      const st = statsFor(e.user);
      if (st && buyerTier(st) === 'vip') seen.add((e.user || '').toLowerCase());
    }
    return seen.size;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, buyerStats]);

  const goFullscreen = () => document.documentElement.requestFullscreen?.().catch(() => {});

  return (
    <div className="fixed inset-0 z-50 bg-gray-950 text-white flex flex-col select-none overflow-hidden">
      {/* top bar */}
      <div className="flex items-center justify-between px-5 py-3 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {brands.length > 1 && brands.map(b => (
            <button
              key={b.id}
              onClick={() => onSwitchBrand?.(b.id)}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
                b.id === brandId ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-white'
              }`}
            >
              {b.name}
            </button>
          ))}
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${
            isLive ? 'bg-red-500/20 text-red-400' : 'bg-gray-800 text-gray-500'
          }`}>
            <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-red-500 animate-pulse' : 'bg-gray-600'}`} />
            {isLive ? 'LIVE' : hasShow ? 'ENDED' : 'NO SHOW'}
          </span>
          <span className="text-gray-400 text-sm truncate">
            {hasShow ? (show.title || 'Live show') : ''}
            {hasShow && show.streaming ? ` · ${show.streaming}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={goFullscreen} title="Fullscreen" className="p-2.5 text-gray-500 hover:text-white rounded-lg">
            <Maximize className="w-5 h-5" />
          </button>
          <button onClick={onClose} title="Close (Esc)" className="p-2.5 text-gray-500 hover:text-white rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {!hasShow ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
          <div className="text-3xl font-bold text-gray-300">No live show right now</div>
          <div className="text-gray-500 max-w-md">
            {error || 'Start streaming with the Palmstreet dashboard open in Chrome — the Folia Label Helper extension feeds this board automatically.'}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-4 px-5 pb-5">
          <div className="lg:col-span-2 flex flex-col gap-4 min-h-0">
            {/* stat tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 flex-shrink-0">
              {[
                ['Gross', fmtMoney(show.totals?.gross)],
                ['Orders', show.totals?.orders ?? '—'],
                ['Sold', sold.length],
                ['Avg price', avg != null ? fmtMoney(Math.round(avg)) : '—'],
                ['VIPs active', vipInRoom],
              ].map(([label, value]) => (
                <div key={label} className="bg-gray-900 rounded-xl px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</div>
                  <div className="text-2xl font-bold tabular-nums mt-0.5">{value}</div>
                </div>
              ))}
            </div>
            {/* current lot */}
            <div className="bg-gray-900 rounded-xl px-5 py-4 flex items-baseline gap-4 flex-shrink-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Current lot</div>
              {show.current ? (
                <>
                  <div className="text-3xl font-bold tabular-nums">#{show.current.lot}</div>
                  <div className="text-2xl text-gray-300 truncate">{show.current.title || ''}</div>
                  <div className="text-3xl font-bold tabular-nums ml-auto" style={{ color: CHART_SOLD }}>
                    {fmtMoney(show.current.price)}
                  </div>
                </>
              ) : <div className="text-2xl text-gray-600">—</div>}
            </div>
            {/* trend */}
            <div className="bg-gray-900 rounded-xl p-4 flex-1 min-h-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
                Price trend this show
              </div>
              <TrendChart sold={sold} startedAt={show.startedAt} />
            </div>
          </div>

          {/* activity feed */}
          <div className="bg-gray-900 rounded-xl p-4 flex flex-col min-h-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-2 flex-shrink-0">
              Room activity — sales, bids, joins
            </div>
            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
              {feed.length === 0 && (
                <div className="text-gray-600 text-sm pt-4">
                  Joins and sales appear as they happen.
                </div>
              )}
              {feed.map((e, i) => (
                <div key={`${e.type}-${e.t}-${e.user}-${i}`} className="flex items-center gap-2 text-sm bg-gray-800/60 rounded-lg px-3 py-2">
                  <span className="text-gray-500 tabular-nums text-xs flex-shrink-0">{fmtClock(e.t)}</span>
                  {e.type === 'sale' && (
                    <>
                      <span className="text-emerald-400 font-semibold flex-shrink-0">WON</span>
                      <span className="truncate min-w-0" title={`#${e.s.lot} ${e.s.title || ''}`}>
                        <span className="font-semibold">@{e.user || '—'}</span>
                        <span className="font-semibold tabular-nums"> · {fmtMoney(e.s.price)}</span>
                        <span className="text-gray-400"> · #{e.s.lot} {e.s.title || ''}</span>
                      </span>
                    </>
                  )}
                  {e.type === 'bid' && (
                    <span className="truncate min-w-0">
                      <span className="font-semibold">@{e.user}</span>
                      <span className="text-gray-400"> bid {e.price != null ? fmtMoney(e.price) : ''}</span>
                    </span>
                  )}
                  {e.type === 'join' && (
                    <span className="truncate min-w-0">
                      <span className="font-semibold">@{e.user}</span>
                      <span className="text-gray-500"> joined</span>
                    </span>
                  )}
                  <span className="ml-auto flex-shrink-0"><BuyerBadge stats={statsFor(e.user)} /></span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
