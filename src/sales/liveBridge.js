// Client glue for the Android-emulator bridge worker (the redroid + scrcpy
// service that this webapp doesn't run, but talks to). One config knob —
// `bridgeUrl` — points at the worker's base URL; the webapp derives the
// stream embed URL and the WebSocket command channel from it.
//
// Wire format (suggested for the bridge to implement):
//
//   GET  ${bridgeUrl}/stream            → embeddable HTML view of the device
//   WS   ${bridgeUrl/http→ws}/commands  → bidirectional JSON channel
//
// Outbound commands sent by the webapp:
//   { type: 'push_listing', item: {sku, name, variety, listingPrice, imageUrl, notes, lotNumber} }
//   { type: 'highlight', sku }
//   { type: 'ping' }
//
// Inbound events the bridge can push back (handled in the modal):
//   { type: 'sold', sku, price, buyer? }
//   { type: 'error', message }
//   { type: 'pong' }

import { useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'live-bridge-config';

export function loadBridgeConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { bridgeUrl: '', authToken: '' };
  } catch {
    return { bridgeUrl: '', authToken: '' };
  }
}

export function saveBridgeConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// Convert http(s)://host/path → ws(s)://host/path. Returns '' if the input
// isn't a valid http/https URL.
export function toWsUrl(httpUrl) {
  if (!httpUrl) return '';
  try {
    const u = new URL(httpUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function streamEmbedUrl(bridgeUrl) {
  if (!bridgeUrl) return '';
  return `${bridgeUrl.replace(/\/$/, '')}/stream`;
}

// React hook: maintains a WebSocket to the bridge worker, exposes connection
// status and a send() helper. Reconnects with backoff on disconnect.
export function useLiveBridge() {
  const [config, setConfig] = useState(() => loadBridgeConfig());
  const [status, setStatus] = useState('idle'); // idle | connecting | connected | disconnected | error
  const [lastEvent, setLastEvent] = useState(null);
  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const reconnectTimerRef = useRef(null);

  const wsUrl = useMemo(() => {
    const base = toWsUrl(config.bridgeUrl);
    return base ? `${base}/commands` : '';
  }, [config.bridgeUrl]);

  useEffect(() => {
    if (!wsUrl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('idle');
      return;
    }

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      setStatus('connecting');
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        setStatus('error');
        scheduleRetry();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setStatus('connected');
        if (config.authToken) {
          try { ws.send(JSON.stringify({ type: 'auth', token: config.authToken })); } catch { /* noop */ }
        }
      };
      ws.onmessage = (msg) => {
        try {
          setLastEvent(JSON.parse(msg.data));
        } catch {
          setLastEvent({ type: 'raw', data: String(msg.data) });
        }
      };
      ws.onerror = () => setStatus('error');
      ws.onclose = () => {
        if (cancelled) return;
        setStatus('disconnected');
        scheduleRetry();
      };
    };

    const scheduleRetry = () => {
      if (cancelled) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, retryRef.current));
      retryRef.current += 1;
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    connect();
    return () => {
      cancelled = true;
      clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* noop */ }
        wsRef.current = null;
      }
    };
    // We intentionally only re-run when wsUrl changes; rapid auth-token
    // changes don't need to reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  const send = (cmd) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(cmd));
      return true;
    } catch {
      return false;
    }
  };

  const updateConfig = (patch) => {
    setConfig(prev => {
      const next = { ...prev, ...patch };
      saveBridgeConfig(next);
      return next;
    });
  };

  return { config, updateConfig, status, send, lastEvent };
}
