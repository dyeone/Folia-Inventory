import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Camera, Keyboard } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';

// Direct @zxing/browser implementation — replaces the html5-qrcode
// wrapper that was hanging iOS Safari on stream release. We own the
// video element, the MediaStream, and the decoder loop so the
// teardown order is predictable.
//
// continuous=false → stop after first decode (box-scan flow)
// continuous=true  → keep scanning with a 2-second per-value debounce
//                    so the same barcode held in view doesn't fire
//                    repeatedly (item-scan flow)

export function CameraScanner({ onScan, onClose, continuous = false }) {
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null);
  const streamRef = useRef(null);
  const closedRef = useRef(false);
  const recentScans = useRef(new Map());

  const [err, setErr] = useState('');
  const [starting, setStarting] = useState(true);
  const [scans, setScans] = useState(0);
  const [manualValue, setManualValue] = useState('');
  const [manualOpen, setManualOpen] = useState(false);

  // Tear down everything we own — decoder, stream tracks, video src.
  // Called from the unmount cleanup and from the synchronous part of
  // the decode callback in one-shot mode. Idempotent.
  const teardown = () => {
    try { controlsRef.current?.stop(); } catch { /* already stopped */ }
    controlsRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try { track.stop(); } catch { /* */ }
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch { /* */ }
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    closedRef.current = false;
    let cancelled = false;

    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;

    (async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch (e) {
        setErr(humanize(e?.message || e || 'Camera unavailable'));
        setStarting(false);
        return;
      }
      if (cancelled) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }

      // iOS Safari requires playsinline + muted to autoplay a stream.
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.muted = true;
      video.srcObject = stream;
      try { await video.play(); } catch { /* iOS sometimes rejects until user gesture */ }

      try {
        // decodeFromVideoElement attaches its own decode loop on the
        // already-playing video. Returns IScannerControls with stop().
        const controls = await reader.decodeFromVideoElement(
          video,
          (result) => {
            if (closedRef.current || !result) return;
            const text = result.getText();
            setScans((c) => c + 1);

            // Debounce identical decodes within 2s.
            const now = Date.now();
            const last = recentScans.current.get(text) || 0;
            if (now - last < 2000) return;
            recentScans.current.set(text, now);

            if (!continuous) {
              // One-shot: synchronously tear the camera down, then
              // unmount the modal, then fire onScan. Doing teardown
              // first means the video element is gone before any
              // parent state change happens.
              closedRef.current = true;
              teardown();
              onClose?.();
              onScan(text);
            } else {
              onScan(text);
            }
          },
        );
        if (cancelled) {
          try { controls.stop(); } catch { /* */ }
          return;
        }
        controlsRef.current = controls;
        setStarting(false);
      } catch (e) {
        if (!cancelled) {
          setErr(humanize(e?.message || e || 'Decoder failed to start'));
          setStarting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      closedRef.current = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuous]);

  const handleManualSubmit = (e) => {
    e?.preventDefault();
    const v = manualValue.trim();
    if (!v) return;
    if (!continuous) {
      closedRef.current = true;
      teardown();
      onClose?.();
    }
    onScan(v);
    setManualValue('');
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 pt-safe text-white bg-black/60">
        <Camera className="w-5 h-5" />
        <div className="flex-1 text-sm font-medium">
          {continuous ? 'Scan items continuously' : 'Scan box label'}
          {scans > 0 && <span className="text-xs text-white/60 ml-2">· {scans} read</span>}
        </div>
        <button
          onClick={() => setManualOpen((v) => !v)}
          aria-label="Type code manually"
          className="p-2 rounded-lg hover:bg-white/10 active:bg-white/20"
        >
          <Keyboard className="w-5 h-5" />
        </button>
        <button
          onClick={() => { closedRef.current = true; teardown(); onClose?.(); }}
          aria-label="Close camera"
          className="p-2 -mr-1 rounded-lg hover:bg-white/10 active:bg-white/20"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 relative bg-black">
        {/* Own video element — we control its lifecycle, not a wrapper lib. */}
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          autoPlay
          playsInline
          muted
        />
        {starting && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
            Starting camera…
          </div>
        )}
        {err && (
          <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-white text-sm bg-red-900/80 rounded-lg p-4">
            {err}
          </div>
        )}
      </div>
      {manualOpen ? (
        <form onSubmit={handleManualSubmit} className="bg-white p-3 pb-safe">
          <label className="block text-xs text-gray-600 mb-1">Type code manually</label>
          <div className="flex gap-2">
            <input
              type="text"
              autoFocus
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
              placeholder={continuous ? 'Item SKU' : 'B-XXXXXX'}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="flex-1 px-3 py-2 text-base font-mono uppercase border-2 border-gray-300 rounded-lg focus:outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              className="px-4 py-2 text-sm font-semibold bg-emerald-600 text-white rounded-lg"
            >
              Send
            </button>
          </div>
        </form>
      ) : (
        <div className="px-4 py-3 pb-safe text-center text-xs text-white/70 bg-black/60">
          {continuous
            ? 'Point at item barcode. Camera stays open.'
            : 'Point at the box label. Camera closes after one scan.'}
          <div className="mt-1 text-white/50">
            Tap <Keyboard className="w-3 h-3 inline -mt-0.5" /> to type instead.
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

function humanize(msg) {
  const m = String(msg);
  if (/NotAllowed|Permission/i.test(m)) {
    return 'Camera permission denied. Open browser settings, allow camera for this site, then retry.';
  }
  if (/NotFound|no.*camera/i.test(m)) {
    return 'No camera found on this device.';
  }
  if (/NotReadable|in use/i.test(m)) {
    return 'Camera is in use by another app. Close it and retry.';
  }
  if (/secure|HTTPS|insecure/i.test(m)) {
    return 'Camera requires HTTPS. Use the deployed site, not localhost over HTTP.';
  }
  return m;
}
