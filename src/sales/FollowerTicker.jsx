import { useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { api } from '../api.js';

// Live Palmstreet follower count for the active brand's store, polled from the
// server-side scrape (api/settings.js `palmstreet-followers`). Shows the count
// plus how many followers arrived since the session baseline — the number the
// host actually calls out ("giveaway at +50!").
//
// The baseline is the first reading of the day (localStorage, per brand): it
// survives closing/reopening the live modals mid-broadcast, and re-arms after
// 12h so tomorrow's live starts counting from zero again.
//
// Unconfigured: admins see a "Set store link" button (paste the app's
// profile-share link once); everyone else sees nothing.

const POLL_MS = 30_000;
const BASELINE_TTL_MS = 12 * 60 * 60 * 1000;

function baselineKey(brandId) {
  return `psFollowerBase:${brandId || 'folia'}`;
}

// Read (or re-arm) the session baseline for the delta display.
function takeBaseline(brandId, current) {
  try {
    const raw = localStorage.getItem(baselineKey(brandId));
    if (raw) {
      const { base, at } = JSON.parse(raw);
      // A count below the baseline means the baseline is stale (unfollows, or
      // a store switch) — re-arm rather than showing a negative delta all day.
      if (Date.now() - at < BASELINE_TTL_MS && Number.isFinite(base) && base <= current) {
        return base;
      }
    }
  } catch { /* fall through to re-arm */ }
  try {
    localStorage.setItem(baselineKey(brandId), JSON.stringify({ base: current, at: Date.now() }));
  } catch { /* private mode — delta just resets per mount */ }
  return current;
}

export function FollowerTicker({ brandId, isAdmin, dark = false, showToast }) {
  // 'loading' | 'unconfigured' | 'ok' | 'error'
  const [state, setState] = useState('loading');
  const [followers, setFollowers] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const alive = useRef(true);

  const poll = async () => {
    try {
      const r = await api.getPalmstreetFollowers();
      if (!alive.current) return;
      if (!r?.configured) { setState('unconfigured'); return; }
      setFollowers(r.followers);
      setBaseline(prev => prev ?? takeBaseline(brandId, r.followers));
      setState('ok');
    } catch {
      // Keep the last shown count; just dim it. First-load failures show
      // nothing rather than an error pill mid-live.
      if (alive.current) setState(prev => (prev === 'ok' ? 'error' : prev === 'loading' ? 'unconfigured' : prev));
    }
  };

  useEffect(() => {
    alive.current = true;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive.current = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  const setLink = async () => {
    const url = window.prompt(
      'Paste your Palmstreet store link (app: your shop profile → Share → Copy link).\nIt looks like https://palmstreet.app/user/…',
    );
    if (!url?.trim()) return;
    try {
      await api.savePalmstreetConfig(url.trim());
      setState('loading');
      setBaseline(null);
      try { localStorage.removeItem(baselineKey(brandId)); } catch { /* fine */ }
      await poll();
    } catch (e) {
      showToast?.(e.message || 'Could not save store link', 'error');
    }
  };

  if (state === 'unconfigured') {
    if (!isAdmin) return null;
    return (
      <button
        onClick={setLink}
        className={`inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 ${
          dark ? 'text-gray-400 hover:text-white hover:bg-gray-800' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
        }`}
        title="Show your Palmstreet follower count here — paste your store link once"
      >
        <Users className="w-3 h-3" /> Set store link
      </button>
    );
  }
  if (followers == null) return null; // loading, nothing to show yet

  const delta = baseline != null ? followers - baseline : 0;
  return (
    <span
      onClick={isAdmin ? setLink : undefined}
      className={`inline-flex items-center gap-1 tabular-nums ${state === 'error' ? 'opacity-50' : ''} ${
        isAdmin ? 'cursor-pointer' : ''
      } ${dark ? 'text-gray-300' : 'text-gray-600'}`}
      title={`Palmstreet followers · refreshes every 30s${isAdmin ? ' · click to change the store link' : ''}`}
    >
      <Users className={`w-3.5 h-3.5 ${dark ? 'text-sky-400' : 'text-sky-600'}`} />
      <span className="font-semibold">{followers.toLocaleString()}</span>
      {delta > 0 && (
        <span className={`font-semibold ${dark ? 'text-emerald-400' : 'text-emerald-600'}`}>
          +{delta}
        </span>
      )}
    </span>
  );
}
