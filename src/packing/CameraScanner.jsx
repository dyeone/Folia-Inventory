import { useEffect, useRef, useState } from 'react';
import { X, Camera } from 'lucide-react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

// Rear-camera barcode scanner using html5-qrcode (wraps ZXing).
// Supports CODE128 (our box + item labels) and QR for future use.
//
// continuous=false  → scanner stops after the first successful decode
//                      (good for box scan — operator scans one and moves on)
// continuous=true   → scanner stays open, decoded codes are debounced so
//                      the same value isn't fired twice within 2s
//                      (good for item scan — rapid-fire many items)
//
// onScan(text) is called once per decode (after debouncing in continuous
// mode). Errors during start surface as inline text, not toasts.

const SCANNER_ELEMENT_ID = 'packer-camera-scanner';

export function CameraScanner({ onScan, onClose, continuous = false }) {
  const [err, setErr] = useState('');
  const [starting, setStarting] = useState(true);
  const scannerRef = useRef(null);
  const recentScans = useRef(new Map());
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    const scanner = new Html5Qrcode(SCANNER_ELEMENT_ID, {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.EAN_13,
      ],
      verbose: false,
    });
    scannerRef.current = scanner;

    const onDecoded = (text) => {
      if (closedRef.current) return;
      // 2-second per-value debounce so a barcode held in view doesn't
      // fire repeatedly.
      const now = Date.now();
      const last = recentScans.current.get(text) || 0;
      if (now - last < 2000) return;
      recentScans.current.set(text, now);
      onScan(text);
      if (!continuous) stopAndClose();
    };

    const stopAndClose = async () => {
      if (closedRef.current) return;
      closedRef.current = true;
      try { await scanner.stop(); } catch { /* already stopped */ }
      onClose?.();
    };

    scanner
      .start(
        // html5-qrcode wants either a plain string or { exact: ... }
        // for facingMode — { ideal: ... } trips its validator with
        // "'facingMode' should be string or object with exact as key".
        // Use the plain string so phones with no rear camera fall back
        // gracefully instead of erroring out.
        { facingMode: 'environment' },
        {
          fps: 10,
          // Aspect ratio matches CODE128 — wide and short.
          qrbox: (vw, vh) => {
            const w = Math.min(vw * 0.9, 400);
            const h = Math.min(vh * 0.5, 200);
            return { width: w, height: h };
          },
          aspectRatio: 1.7777,
        },
        onDecoded,
        () => { /* decode-miss frames are noisy; ignore */ },
      )
      .then(() => setStarting(false))
      .catch((e) => {
        setErr(humanize(e?.message || e || 'Camera unavailable'));
        setStarting(false);
      });

    return () => {
      closedRef.current = true;
      scanner.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuous]);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 pt-safe text-white bg-black/60">
        <Camera className="w-5 h-5" />
        <div className="flex-1 text-sm font-medium">
          {continuous ? 'Scan items continuously' : 'Scan box label'}
        </div>
        <button
          onClick={onClose}
          aria-label="Close camera"
          className="p-2 -mr-1 rounded-lg hover:bg-white/10 active:bg-white/20"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 relative">
        <div id={SCANNER_ELEMENT_ID} className="w-full h-full" />
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
      <div className="px-4 py-3 pb-safe text-center text-xs text-white/70 bg-black/60">
        {continuous
          ? 'Point at item barcode. Camera stays open.'
          : 'Point at the box label. Camera closes after one scan.'}
      </div>
    </div>
  );
}

// html5-qrcode surfaces the raw browser error which is opaque on a phone
// ("NotAllowedError" etc.). Translate the common ones to something a
// warehouse operator can act on.
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
