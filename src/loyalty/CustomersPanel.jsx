import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { api } from '../api.js';

// ░░ BAE customer hub — customer roster (Loyalty ▸ Customers) ░░
//
// Read-only list of the brand's customers (Supabase Auth signups from the
// BAE Badges app, rows in `customers`) with per-customer aggregates computed
// server-side: badges earned, orders claimed, rewards pending/fulfilled.
// Admin-only — the server gates loyalty-customers because the roster carries
// customer PII (email/phone).

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function CountPill({ children, highlight }) {
  return (
    <span
      className={`text-xs rounded-full px-2 py-0.5 whitespace-nowrap tabular-nums ${highlight
        ? 'bg-red-100 text-red-700 font-medium'
        : 'bg-gray-100 text-gray-600'}`}
    >
      {children}
    </span>
  );
}

function CustomerRow({ customer }) {
  const who = customer.displayName || customer.email || customer.phone || 'Unknown';
  const contact = [customer.email, customer.phone].filter(v => v && v !== who).join(' · ');
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-900 truncate">{who}</div>
        <div className="text-xs text-gray-500 truncate">
          {contact ? `${contact} · ` : ''}joined {formatDate(customer.createdAt)}
        </div>
      </div>
      <CountPill>{customer.badges} badges</CountPill>
      <CountPill>{customer.orders} orders</CountPill>
      {customer.rewardsPending > 0 ? (
        <CountPill highlight>{customer.rewardsPending} pending</CountPill>
      ) : (
        <CountPill>{customer.rewardsFulfilled} rewards</CountPill>
      )}
    </div>
  );
}

export function CustomersPanel({ showToast }) {
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [customers, setCustomers] = useState([]);
  const [sort, setSort] = useState('newest');
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    try {
      const r = await api.listLoyaltyCustomers();
      setUnavailable(!!r.unavailable);
      setCustomers(r.customers || []);
    } catch (e) {
      showToast?.(e.message || 'Failed to load customers', 'error');
    } finally {
      setReady(true);
      setRefreshing(false);
    }
  }

  // load only setState()s after an await, so this isn't the cascading
  // synchronous update the rule guards against (same idiom as LoyaltyAdmin).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500 text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading customers…
      </div>
    );
  }

  const q = search.trim().toLowerCase();
  const visible = customers
    .filter(c => !q || [c.displayName, c.email, c.phone].some(v => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => (sort === 'badges'
      ? (b.badges - a.badges) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      : String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));

  return (
    <div className="space-y-4">
      {unavailable && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl px-4 py-3">
          The customer tables aren&apos;t set up yet — apply{' '}
          <code className="font-mono">supabase/migrations/0034_bae_loyalty.sql</code> (then{' '}
          <code className="font-mono">0035_bae_customer_hub.sql</code>) in the Supabase SQL editor,
          then refresh.
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, email, phone"
            className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-1.5 text-sm"
          />
        </div>
        <select
          value={sort}
          onChange={e => setSort(e.target.value)}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white"
        >
          <option value="newest">Newest</option>
          <option value="badges">Most badges</option>
        </select>
        <button
          onClick={() => { setRefreshing(true); load(); }}
          disabled={refreshing}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {visible.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500">
            {customers.length === 0
              ? 'Customers appear here after their first sign-in in the BAE Badges app.'
              : 'No customers match your search.'}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visible.map(c => <CustomerRow key={c.id} customer={c} />)}
          </div>
        )}
      </div>

      {customers.length > 0 && (
        <p className="text-xs text-gray-500">
          {customers.length} customer{customers.length === 1 ? '' : 's'}
          {customers.length >= 500 ? ' (showing the newest 500)' : ''}
        </p>
      )}
    </div>
  );
}
