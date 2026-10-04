import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Sprout, ScanLine, Check, AlertTriangle, Undo2, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { normalizeSku } from '../labels/boxCode.js';

// Acclimation at the packing bench: scan each TC's label and it goes into
// "acclimated" (items action=acclimate). The list shows this session's
// scans newest first — done, already in, or why not — with Undo per row.
// Same HID-scanner conventions as the other bench scanners: the input
// keeps focus, Enter submits, a SKU-shaped value submits by itself.

export function AcclimationPane({ onClose, showToast, totalAcclimated, onChanged }) {
  const [scanInput, setScanInput] = useState('');
  const [entries, setEntries] = useState([]);      // { key, sku, state: 'done'|'already'|'error'|'reverted'|'busy', name, variety, message }
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); });

  const done = entries.filter((e) => e.state === 'done').length;

  const scan = async (raw) => {
    const sku = normalizeSku(raw);
    if (!sku) return;
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setEntries((prev) => [{ key, sku, state: 'busy' }, ...prev].slice(0, 200));
    setBusy(true);
    try {
      const r = await api.acclimateSkus([sku]);
      const res = r.results?.[0];
      setEntries((prev) => prev.map((e) => (e.key === key ? {
        ...e,
        state: res?.ok ? 'done' : res?.already ? 'already' : 'error',
        name: res?.item?.name || '',
        variety: res?.item?.variety || '',
        message: res?.ok ? 'in acclimation' : res?.error || 'failed',
      } : e)));
      if (res?.ok) onChanged?.();
    } catch (err) {
      setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, state: 'error', message: err.message || 'network error' } : e)));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (entry) => {
    try {
      const r = await api.acclimateSkus([entry.sku], { revert: true });
      const res = r.results?.[0];
      if (res?.ok) {
        setEntries((prev) => prev.map((e) => (e.key === entry.key ? { ...e, state: 'reverted', message: 'back to available' } : e)));
        onChanged?.();
      } else showToast?.(res?.error || 'Could not undo', 'error');
    } catch (err) {
      showToast?.(err.message || 'Could not undo', 'error');
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!scanInput) return;
    scan(scanInput);
    setScanInput('');
  };
  // Scanner dropped its Enter: a settled SKU-shaped value submits by itself.
  const scanRef = useRef(scan);
  scanRef.current = scan;
  useEffect(() => {
    if (!scanInput || !/^(?:[A-Za-z]{2,8}-){0,2}[A-Za-z]{2,8}-\d+$/.test(scanInput.trim())) return undefined;
    const id = setTimeout(() => { scanRef.current(scanInput); setScanInput(''); }, 200);
    return () => clearTimeout(id);
  }, [scanInput]);

  const tone = (st) => st === 'done' ? 'border-fuchsia-300 bg-fuchsia-50' : st === 'already' ? 'border-amber-300 bg-amber-50' : st === 'error' ? 'border-red-300 bg-red-50' : st === 'reverted' ? 'border-gray-300 bg-gray-50' : 'border-gray-200 bg-white';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-4 sm:px-5 py-3 border-b border-fuchsia-200 bg-fuchsia-50">
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          <button type="button" onClick={onClose} className="p-3 -ml-2 rounded-lg text-fuchsia-800 hover:bg-fuchsia-100 active:bg-fuchsia-200" aria-label="Back"><ChevronLeft className="w-6 h-6" /></button>
          <Sprout className="w-6 h-6 text-fuchsia-700 shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-fuchsia-900 truncate">Acclimation</h2>
            <p className="text-xs text-fuchsia-800">Scan each TC's label to put it into acclimation · {totalAcclimated} in acclimation now · {done} scanned this session</p>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4">
        <div className="max-w-3xl mx-auto space-y-4">
          <form onSubmit={onSubmit}>
            <div className="relative">
              <ScanLine className="w-6 h-6 text-fuchsia-500 absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                ref={inputRef}
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="Scan a SKU…"
                autoComplete="off"
                autoCapitalize="characters"
                className="w-full pl-14 pr-4 py-4 text-xl font-mono tracking-wide rounded-2xl border-2 border-fuchsia-300 focus:border-fuchsia-500 focus:ring-4 focus:ring-fuchsia-100 outline-none bg-white"
              />
              {busy && <Loader2 className="w-5 h-5 text-fuchsia-500 animate-spin absolute right-4 top-1/2 -translate-y-1/2" />}
            </div>
          </form>
          {entries.length === 0 ? (
            <div className="text-center text-gray-500 py-10">
              <Sprout className="w-10 h-10 mx-auto mb-2 text-fuchsia-300" />
              Scan the first TC. Each scan moves that plant into acclimation; the admin's Acclimation tab lists them all.
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((e) => (
                <div key={e.key} className={`rounded-xl border-2 px-3 py-2.5 flex items-center gap-3 ${tone(e.state)}`}>
                  <div className="shrink-0">
                    {e.state === 'busy' ? <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
                      : e.state === 'done' ? <Check className="w-5 h-5 text-fuchsia-700" />
                      : e.state === 'reverted' ? <Undo2 className="w-5 h-5 text-gray-500" />
                      : <AlertTriangle className={`w-5 h-5 ${e.state === 'already' ? 'text-amber-600' : 'text-red-600'}`} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono font-bold text-gray-900">{e.sku}{e.name ? <span className="font-sans font-medium text-gray-700"> · {e.name}</span> : ''}</div>
                    <div className="text-xs text-gray-600">{e.variety ? `${e.variety} · ` : ''}{e.message || '…'}</div>
                  </div>
                  {e.state === 'done' && (
                    <button type="button" onClick={() => undo(e)} className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-gray-700 border border-gray-300 bg-white rounded-lg px-2.5 py-1.5 hover:bg-gray-50"><Undo2 className="w-3.5 h-3.5" /> Undo</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
