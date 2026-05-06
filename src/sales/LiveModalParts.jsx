import { useState } from 'react';
import {
  X, Radio, Check, RotateCcw, Play, ChevronRight, AlertCircle, ListOrdered,
  Smartphone, Settings, Wifi, WifiOff, Send, Gift,
} from 'lucide-react';
import { streamEmbedUrl } from './liveBridge.js';

// Tonal section header used by the LiveModal pane to delineate
// queued / current / done lists.
export function Section({ label, count, tone, sub, actionLabel, onAction, children }) {
  const dotTone = {
    red:     'bg-red-500',
    emerald: 'bg-emerald-500',
    amber:   'bg-amber-500',
    gray:    'bg-gray-400',
  }[tone] || 'bg-gray-400';
  return (
    <section>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${dotTone}`} />
          <h3 className="font-semibold text-gray-900">{label}</h3>
          <span className="text-xs text-gray-500 tabular-nums">{count}</span>
          {sub && <span className="text-xs text-gray-400">· {sub}</span>}
        </div>
        {actionLabel && (
          <button onClick={onAction} className="text-xs text-gray-600 hover:text-gray-900 font-medium">
            {actionLabel}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

export function ItemList({ children }) {
  return <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">{children}</div>;
}

export function EmptyHint({ message }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
      <AlertCircle className="w-4 h-4" /> {message}
    </div>
  );
}

export function CurrentItemCard(props) {
  const { item, onSold, onRequeue, bridgeReady, pushed, onPush } = props;
  return (
    <div className="bg-red-600 text-white rounded-xl p-5 sm:p-6 shadow-lg">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-red-100 mb-1">
            <Radio className="w-3.5 h-3.5 animate-pulse" /> Now Live
          </div>
          {item.lotNumber && (
            <div className="text-xs text-red-200 font-mono mb-1">
              <ListOrdered className="w-3 h-3 inline mr-1" /> Lot #{item.lotNumber}
            </div>
          )}
          <div className="text-2xl sm:text-3xl font-bold leading-tight">
            {item.name}
          </div>
          {item.variety && (
            <div className="text-base text-red-100 mt-0.5">{item.variety}</div>
          )}
          <div className="text-xs text-red-200 font-mono mt-1">{item.sku}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wide text-red-200">Listing</div>
          <div className="text-3xl sm:text-4xl font-bold tabular-nums">
            ${parseFloat(item.listingPrice || 0).toFixed(0)}
          </div>
        </div>
      </div>
      {item.notes && (
        <div className="mt-3 text-sm text-red-50 bg-red-700/60 rounded-lg px-3 py-2">
          {item.notes}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onSold}
          className="flex-1 min-w-[160px] flex items-center justify-center gap-1.5 px-4 py-3 text-base font-medium bg-white text-red-700 hover:bg-red-50 active:bg-red-100 rounded-lg"
        >
          <Check className="w-5 h-5" /> Mark Sold
        </button>
        <button
          onClick={onPush}
          disabled={!bridgeReady}
          title={bridgeReady ? 'Push to Palmstreet via bridge' : 'Bridge not connected'}
          className={`flex items-center justify-center gap-1.5 px-4 py-3 text-sm font-medium rounded-lg ${
            pushed
              ? 'bg-emerald-200 text-emerald-900'
              : bridgeReady
              ? 'bg-red-800 text-white hover:bg-red-900'
              : 'bg-red-700/40 text-red-200 cursor-not-allowed'
          }`}
        >
          {pushed ? <Check className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          {pushed ? 'Pushed' : 'Push to Palmstreet'}
        </button>
        <button
          onClick={onRequeue}
          className="flex items-center justify-center gap-1.5 px-4 py-3 text-sm font-medium bg-red-700/80 text-white hover:bg-red-800 active:bg-red-900 rounded-lg"
        >
          <RotateCcw className="w-4 h-4" /> Re-queue
        </button>
      </div>
    </div>
  );
}

export function QueuedRow(props) {
  const { item, flashed, onGoLive, bridgeReady, pushed, onPush } = props;
  return (
    <div className={`flex items-center gap-3 px-3 sm:px-4 py-3 transition ${
      flashed ? 'bg-emerald-100' : 'hover:bg-gray-50'
    }`}>
      <div className="w-12 text-center">
        {item.lotNumber ? (
          <span className="inline-block px-2 py-1 text-xs font-mono font-semibold bg-gray-100 text-gray-700 rounded">
            #{item.lotNumber}
          </span>
        ) : (
          <span className="text-xs text-gray-300">—</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 truncate">{item.name}</div>
        <div className="text-xs text-gray-500 truncate">
          {item.variety ? `${item.variety} · ` : ''}<span className="font-mono">{item.sku}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-lg font-semibold text-gray-900 tabular-nums">
          ${parseFloat(item.listingPrice || 0).toFixed(0)}
        </div>
      </div>
      <button
        onClick={onPush}
        disabled={!bridgeReady}
        title={bridgeReady ? 'Push to Palmstreet via bridge' : 'Bridge not connected'}
        aria-label="Push to Palmstreet"
        className={`p-2 rounded-lg flex-shrink-0 ${
          pushed
            ? 'text-emerald-700 bg-emerald-50'
            : bridgeReady
            ? 'text-gray-700 hover:bg-gray-100 active:bg-gray-200'
            : 'text-gray-300 cursor-not-allowed'
        }`}
      >
        {pushed ? <Check className="w-4 h-4" /> : <Send className="w-4 h-4" />}
      </button>
      <button
        onClick={onGoLive}
        className="flex items-center gap-1 px-3 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 active:bg-red-800 text-white rounded-lg flex-shrink-0"
      >
        <Play className="w-3.5 h-3.5" /> Go Live
      </button>
    </div>
  );
}

export function DoneRow({ item, onUndo }) {
  return (
    <div className="flex items-center gap-3 px-3 sm:px-4 py-2.5 opacity-70 hover:opacity-100">
      <div className="w-12 text-center">
        {item.lotNumber && (
          <span className="inline-block px-2 py-0.5 text-xs font-mono text-gray-500">
            #{item.lotNumber}
          </span>
        )}
      </div>
      <Check className="w-4 h-4 text-emerald-600 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-700 truncate line-through">{item.name}</div>
        <div className="text-xs text-gray-400 font-mono truncate">{item.sku}</div>
      </div>
      <div className="text-sm text-gray-500 tabular-nums">
        ${parseFloat(item.listingPrice || 0).toFixed(0)}
      </div>
      <button
        onClick={onUndo}
        className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        title="Re-queue"
        aria-label="Undo"
      >
        <ChevronRight className="w-4 h-4 rotate-180" />
      </button>
    </div>
  );
}

export function GiveawayRow({ item }) {
  return (
    <div className="flex items-center gap-3 px-3 sm:px-4 py-2.5">
      <Gift className="w-4 h-4 text-amber-600 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{item.name}</div>
        <div className="text-xs text-gray-500 truncate">
          {item.variety ? `${item.variety} · ` : ''}<span className="font-mono">{item.sku}</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────── Bridge UI ──────────────────────────────────────────────

export function BridgeBadge({ status, onSettings }) {
  const tone = status === 'connected' ? 'text-emerald-400'
    : status === 'connecting' ? 'text-amber-400 animate-pulse'
    : status === 'idle' ? 'text-gray-500'
    : 'text-red-400';
  const Icon = status === 'connected' ? Wifi : WifiOff;
  return (
    <button
      onClick={onSettings}
      className="inline-flex items-center gap-1 hover:bg-gray-800 active:bg-gray-700 rounded px-1.5 py-0.5 -my-0.5"
      title="Bridge settings"
    >
      <Icon className={`w-3.5 h-3.5 ${tone}`} />
      <span className={tone}>{
        status === 'idle' ? 'Bridge off'
        : status === 'connecting' ? 'Connecting…'
        : status === 'connected' ? 'Bridge on'
        : status === 'disconnected' ? 'Reconnecting…'
        : 'Bridge error'
      }</span>
      <Settings className="w-3 h-3 text-gray-500 ml-0.5" />
    </button>
  );
}

export function BridgeDot({ status }) {
  const tone = status === 'connected' ? 'bg-emerald-400'
    : status === 'connecting' ? 'bg-amber-400 animate-pulse'
    : status === 'idle' ? 'bg-gray-500'
    : 'bg-red-400';
  return <span className={`inline-block w-2 h-2 rounded-full ml-1.5 ${tone}`} />;
}

export function PaneTab(props) {
  const { active, onClick, icon: Icon, children } = props;
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition ${
        active
          ? 'border-emerald-500 text-white'
          : 'border-transparent text-gray-400 hover:text-white'
      }`}
    >
      <Icon className="w-4 h-4" /> {children}
    </button>
  );
}

export function StreamPane({ bridge, onOpenSettings }) {
  const url = streamEmbedUrl(bridge.config.bridgeUrl);
  if (!bridge.config.bridgeUrl) {
    return (
      <div className="flex-1 overflow-y-auto bg-gray-100 flex items-center justify-center p-6">
        <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md text-center shadow-sm">
          <Smartphone className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <h3 className="font-semibold text-gray-900 mb-1">Bridge not configured</h3>
          <p className="text-sm text-gray-600 mb-4">
            Point this view at your redroid + scrcpy worker URL to stream the
            Android emulator and push live items into Palmstreet.
          </p>
          <button
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg"
          >
            <Settings className="w-4 h-4" /> Configure Bridge
          </button>
        </div>
      </div>
    );
  }
  if (bridge.status !== 'connected') {
    return (
      <div className="flex-1 overflow-y-auto bg-gray-100 flex items-center justify-center p-6">
        <div className="bg-white border border-gray-200 rounded-2xl p-8 max-w-md text-center shadow-sm">
          <WifiOff className="w-12 h-12 text-amber-500 mx-auto mb-3" />
          <h3 className="font-semibold text-gray-900 mb-1">
            {bridge.status === 'connecting' ? 'Connecting to bridge…'
              : bridge.status === 'disconnected' ? 'Reconnecting to bridge…'
              : 'Bridge unreachable'}
          </h3>
          <p className="text-sm text-gray-600 mb-4 break-all">
            {bridge.config.bridgeUrl}
          </p>
          <button
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg"
          >
            <Settings className="w-4 h-4" /> Edit settings
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 bg-black flex items-center justify-center">
      <iframe
        src={url}
        title="Palmstreet bridge"
        className="w-full h-full border-0"
        allow="autoplay; clipboard-write"
      />
    </div>
  );
}

export function BridgeSettingsDialog({ config, status, onSave, onClose }) {
  const [bridgeUrl, setBridgeUrl] = useState(config.bridgeUrl || '');
  const [authToken, setAuthToken] = useState(config.authToken || '');

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-emerald-600" /> Bridge Settings
          </h3>
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3">
            Point this at your redroid + scrcpy worker (the Linux VPS running
            the Android emulator). The webapp will load <code className="font-mono">/stream</code> in
            an iframe and open a WebSocket on <code className="font-mono">/commands</code>.
          </div>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 block mb-1.5">Bridge URL</span>
            <input
              type="url"
              value={bridgeUrl}
              onChange={(e) => setBridgeUrl(e.target.value)}
              placeholder="https://bridge.example.com"
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700 block mb-1.5">Auth token (optional)</span>
            <input
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder="Shared secret sent on connect"
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <div className="text-xs text-gray-500">
            Current status: <span className="font-medium text-gray-700">{status}</span>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={() => onSave({ bridgeUrl: bridgeUrl.trim(), authToken: authToken.trim() })}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
