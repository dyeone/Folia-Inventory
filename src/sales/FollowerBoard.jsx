import { useEffect, useRef, useState } from 'react';
import { Maximize, X } from 'lucide-react';
import { api } from '../api.js';
import { takeBaseline } from './FollowerTicker.jsx';

// Audience-facing follower board — a full-screen giant counter meant to be
// pointed at the camera (spare tablet / monitor in frame) during a live.
// Reached via the #follower-board hash on any logged-in device; the board
// tracks whichever brand that device's session has active.
//
// Optional follow goal ("giveaway at 1,000!"): tap the number to set it,
// stored per brand on the display device. Shows a progress bar + "to go"
// until the goal is passed, then flips to a celebration state.
//
// Poll cadence matches the server-side cache (3s) so the audience sees new
// follows almost as they land.

const POLL_MS = 3_000;

function goalKey(brandId) {
  return `psFollowerGoal:${brandId || 'folia'}`;
}

const BRAND_LABEL = { folia: 'Folia', bae: 'BAE' };

export function FollowerBoard({ brandId, brands = [], onSwitchBrand, onClose }) {
  const [followers, setFollowers] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [error, setError] = useState(null);
  const [goal, setGoal] = useState(() => {
    const g = parseInt(localStorage.getItem(goalKey(brandId)), 10);
    return Number.isFinite(g) && g > 0 ? g : null;
  });
  // Brief scale-pulse when the count goes up.
  const [bump, setBump] = useState(false);
  const prevRef = useRef(null);
  const alive = useRef(true);

  const poll = async () => {
    try {
      const r = await api.getPalmstreetFollowers(brandId);
      if (!alive.current) return;
      if (!r?.configured) { setError('No store link set — configure it in the live screen first.'); return; }
      setError(null);
      setFollowers(r.followers);
      setBaseline(prev => prev ?? takeBaseline(brandId, r.followers));
      if (prevRef.current != null && r.followers > prevRef.current) {
        setBump(true);
        setTimeout(() => alive.current && setBump(false), 900);
      }
      prevRef.current = r.followers;
    } catch (e) {
      if (alive.current && followers == null) setError(e.message || 'Could not load followers');
      // With a number already up, keep showing it through transient failures.
    }
  };

  useEffect(() => {
    alive.current = true;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive.current = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  // Esc leaves the board (matches every modal in the app).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const editGoal = () => {
    const raw = window.prompt('Follow goal for this live (blank to clear):', goal ?? '');
    if (raw === null) return;
    const g = parseInt(raw, 10);
    if (Number.isFinite(g) && g > 0) {
      setGoal(g);
      try { localStorage.setItem(goalKey(brandId), String(g)); } catch { /* fine */ }
    } else {
      setGoal(null);
      try { localStorage.removeItem(goalKey(brandId)); } catch { /* fine */ }
    }
  };

  const goFullscreen = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  };

  const delta = followers != null && baseline != null ? followers - baseline : 0;
  const goalReached = goal != null && followers != null && followers >= goal;
  const toGo = goal != null && followers != null ? Math.max(0, goal - followers) : null;
  const progress = goal ? Math.min(100, ((followers || 0) / goal) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-gray-950 text-white flex flex-col items-center justify-center select-none group">
      <style>{`
        @keyframes fb-pop { 0% { transform: scale(1); } 35% { transform: scale(1.07); } 100% { transform: scale(1); } }
      `}</style>

      {/* Faint controls — visible on hover so the on-camera frame stays clean. */}
      <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={goFullscreen} title="Fullscreen" className="p-2.5 text-gray-500 hover:text-white rounded-lg">
          <Maximize className="w-5 h-5" />
        </button>
        <button onClick={onClose} title="Close (Esc)" className="p-2.5 text-gray-500 hover:text-white rounded-lg">
          <X className="w-5 h-5" />
        </button>
      </div>
      {/* Brand switcher — same hover-reveal as the corner controls. */}
      {brands.length > 1 && (
        <div className="absolute top-3 left-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {brands.map(b => (
            <button
              key={b.id}
              onClick={() => onSwitchBrand?.(b.id)}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg ${
                b.id === brandId ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-white'
              }`}
            >
              {b.name || BRAND_LABEL[b.id] || b.id}
            </button>
          ))}
        </div>
      )}

      <button
        onClick={() => {
          // Clicking the title also cycles brands — handy on a touch display
          // where hover-reveal pills are awkward.
          if (brands.length > 1 && onSwitchBrand) {
            const i = brands.findIndex(b => b.id === brandId);
            onSwitchBrand(brands[(i + 1) % brands.length].id);
          }
        }}
        className="bg-transparent border-0 cursor-pointer text-[3vmin] font-semibold tracking-[0.4em] uppercase text-gray-500"
        title={brands.length > 1 ? 'Tap to switch brand' : undefined}
      >
        {(brands.find(b => b.id === brandId)?.name || BRAND_LABEL[brandId] || brandId || '')} Followers
      </button>

      {error ? (
        <div className="mt-6 text-[2.5vmin] text-gray-400 max-w-[70vw] text-center">{error}</div>
      ) : (
        <>
          <button
            onClick={editGoal}
            title="Tap to set a follow goal"
            className="bg-transparent border-0 cursor-pointer leading-none font-bold tabular-nums text-red-500"
            style={{
              // As big as fits: vmin-driven, capped by width so a 5-digit
              // count never clips on narrow/portrait displays.
              fontSize: 'min(44vmin, 24vw)',
              animation: bump ? 'fb-pop 0.9s ease' : 'none',
            }}
          >
            {followers == null ? '—' : followers.toLocaleString()}
          </button>

          <div className="h-[6vmin] flex items-center">
            {delta > 0 && (
              <span className="text-[4.5vmin] font-bold text-emerald-400 tabular-nums">
                +{delta.toLocaleString()} today
              </span>
            )}
          </div>

          {goal != null && followers != null && (
            <div className="mt-[2vmin] w-[60vmin] max-w-[80vw]">
              {goalReached ? (
                <div className="text-center text-[5vmin] font-bold text-amber-300">
                  🎉 {goal.toLocaleString()} GOAL REACHED! 🎉
                </div>
              ) : (
                <>
                  <div className="h-[2.2vmin] rounded-full bg-gray-800 overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all duration-700"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="mt-[1.5vmin] text-center text-[3vmin] text-gray-400 tabular-nums">
                    <span className="text-white font-semibold">{toGo.toLocaleString()}</span> to go
                    · goal {goal.toLocaleString()}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
