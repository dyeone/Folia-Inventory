import { useEffect, useState } from 'react';
import { Award, Check, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../api.js';

// ░░ BAE loyalty program admin (in-app tab, admin + BAE brand only) ░░
//
// Two jobs, matching the customer loop in the bae-loyalty-app repo:
//   1. Set the punch-card economics (reward_config: threshold + reward text).
//      The customer app reads this row directly via Supabase RLS, so Save
//      here changes what every customer sees.
//   2. Fulfill rewards: when a customer's badges cross the threshold, the
//      claim RPC creates a reward_redemptions row with a code the customer
//      shows staff. Verify the code on their screen, hand over the reward,
//      mark it fulfilled here.
//
// Tables ship via migration 0034_bae_loyalty.sql (manual apply); until then
// the API answers `unavailable` and this panel shows a setup banner.

const EMPTY_CONFIG = { threshold: 10, rewardTitle: '', rewardDetail: '', active: true };

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// XXXXXXXX → XXXX-XXXX, same grouping as the app + slip.
function groupCode(code) {
  return String(code || '').replace(/(.{4})(?=.)/g, '$1-');
}

function StatTile({ label, value }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="text-2xl font-semibold text-gray-900 tabular-nums">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

function RedemptionRow({ redemption, busy, onToggle }) {
  const { customer, status } = redemption;
  const pending = status === 'pending';
  const who = customer?.displayName || customer?.email || customer?.phone || 'Unknown customer';
  const contact = customer?.displayName && customer?.email ? customer.email : null;
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${pending ? '' : 'opacity-60'}`}>
      <div className={`font-mono text-base font-bold tracking-widest px-2.5 py-1 rounded-lg border border-dashed ${pending ? 'border-gray-400 text-gray-900 bg-gray-50' : 'border-gray-300 text-gray-500'}`}>
        {groupCode(redemption.code)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-900 truncate">{who}</div>
        <div className="text-xs text-gray-500 truncate">
          {contact ? `${contact} · ` : ''}
          {redemption.thresholdMet} badges · {pending
            ? `unlocked ${formatDate(redemption.createdAt)}`
            : `fulfilled ${formatDate(redemption.fulfilledAt)}`}
        </div>
      </div>
      {pending ? (
        <button
          onClick={() => onToggle(redemption, true)}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Fulfilled
        </button>
      ) : (
        <button
          onClick={() => onToggle(redemption, false)}
          disabled={busy}
          title="Undo — back to pending"
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-60"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Undo
        </button>
      )}
    </div>
  );
}

export function LoyaltyAdmin({ showToast }) {
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [stats, setStats] = useState(null);
  const [redemptions, setRedemptions] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  async function load() {
    try {
      const [loyalty, rows] = await Promise.all([api.getLoyalty(), api.listLoyaltyRedemptions()]);
      setUnavailable(!!loyalty.unavailable);
      if (loyalty.config) {
        setConfig({
          threshold: loyalty.config.threshold ?? 10,
          rewardTitle: loyalty.config.rewardTitle ?? '',
          rewardDetail: loyalty.config.rewardDetail ?? '',
          active: loyalty.config.active !== false,
        });
        setDirty(false);
      }
      setStats(loyalty.stats || null);
      setRedemptions(rows);
    } catch (e) {
      showToast?.(e.message || 'Failed to load loyalty program', 'error');
    } finally {
      setReady(true);
      setRefreshing(false);
    }
  }

  // load only setState()s after an await, so this isn't the cascading
  // synchronous update the rule guards against (same idiom as AssignedView).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function patch(p) {
    setConfig(c => ({ ...c, ...p }));
    setDirty(true);
  }

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const saved = await api.saveLoyaltyConfig(config);
      setConfig({
        threshold: saved.threshold,
        rewardTitle: saved.rewardTitle ?? '',
        rewardDetail: saved.rewardDetail ?? '',
        active: saved.active !== false,
      });
      setDirty(false);
      showToast?.('Loyalty program saved — live in the customer app');
    } catch (e) {
      showToast?.(e.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function toggleFulfilled(redemption, fulfilled) {
    setBusyId(redemption.id);
    try {
      const updated = await api.fulfillLoyaltyRedemption(redemption.id, fulfilled);
      setRedemptions(rs => rs.map(r => (r.id === updated.id ? { ...r, ...updated } : r)));
      showToast?.(fulfilled ? 'Reward marked fulfilled' : 'Reward moved back to pending');
    } catch (e) {
      showToast?.(e.message || 'Update failed', 'error');
    } finally {
      setBusyId(null);
    }
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500 text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading loyalty program…
      </div>
    );
  }

  const pending = redemptions.filter(r => r.status === 'pending');
  const fulfilled = redemptions.filter(r => r.status !== 'pending');

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Award className="w-5 h-5 text-red-600" />
        <h2 className="text-lg font-semibold text-gray-900">BAE Badges — loyalty program</h2>
        <button
          onClick={() => { setRefreshing(true); load(); }}
          disabled={refreshing}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {unavailable && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl px-4 py-3">
          The loyalty tables aren&apos;t set up yet — apply{' '}
          <code className="font-mono">supabase/migrations/0034_bae_loyalty.sql</code> in the Supabase
          SQL editor, then refresh.
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatTile label="Codes printed" value={stats.codesIssued} />
          <StatTile label="Codes claimed" value={stats.codesClaimed} />
          <StatTile label="Badges earned" value={stats.badgesGranted} />
          <StatTile label="Rewards pending" value={stats.rewardsPending} />
          <StatTile label="Rewards fulfilled" value={stats.rewardsFulfilled} />
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Punch card</h3>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={config.active}
              onChange={e => patch({ active: e.target.checked })}
              className="rounded border-gray-300"
            />
            Program active
          </label>
        </div>
        <p className="text-xs text-gray-500 -mt-2">
          Every plant in a BAE box earns one badge (the code prints on the shipping slip
          automatically). When a customer&apos;s badges reach the threshold, the app unlocks the
          reward below and it shows up in the pending list here.
        </p>
        <div className="grid sm:grid-cols-[8rem_1fr] gap-4">
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 mb-1">Badges needed</span>
            <input
              type="number"
              min="1"
              max="1000"
              value={config.threshold}
              onChange={e => patch({ threshold: e.target.value === '' ? '' : parseInt(e.target.value, 10) })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 mb-1">Reward</span>
            <input
              type="text"
              value={config.rewardTitle}
              onChange={e => patch({ rewardTitle: e.target.value })}
              placeholder="e.g. Free BAE anthurium"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>
        <label className="block">
          <span className="block text-xs font-medium text-gray-500 mb-1">Reward details (shown in the app)</span>
          <textarea
            rows={2}
            value={config.rewardDetail}
            onChange={e => patch({ rewardDetail: e.target.value })}
            placeholder="How the customer redeems it — at a live, on their next order…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-y"
          />
        </label>
        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving || !dirty || unavailable}
            className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Save
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Pending rewards</h3>
          {pending.length > 0 && (
            <span className="text-xs bg-red-100 text-red-700 rounded-full px-2 py-0.5">{pending.length}</span>
          )}
        </div>
        {pending.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500">
            Nothing waiting. When a customer unlocks a reward, verify the code on their screen
            against this list, hand it over, and mark it fulfilled.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pending.map(r => (
              <RedemptionRow key={r.id} redemption={r} busy={busyId === r.id} onToggle={toggleFulfilled} />
            ))}
          </div>
        )}
      </div>

      {fulfilled.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Fulfilled</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {fulfilled.map(r => (
              <RedemptionRow key={r.id} redemption={r} busy={busyId === r.id} onToggle={toggleFulfilled} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
