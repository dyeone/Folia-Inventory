import { useEffect, useRef, useState } from 'react';
import { X, Camera, Keyboard } from 'lucide-react';
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
  const [scans, setScans] = useState(0); // visible decode counter for sanity-checking
  const [manualValue, setManualValue] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
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
      setScans(c => c + 1);
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
          // Bumping fps from 10 → 20 to give ZXing more frames to land
          // a decode on. CODE128 reads better with more attempts when
          // the camera is slightly out of focus.
          fps: 20,
          // Wider, shorter scan window — CODE128 barcodes are long and
          // narrow, and a tall qrbox often misses them. Filling almost
          // the entire viewport width gives ZXing the best chance.
          qrbox: (vw, vh) => ({
            width: Math.min(vw, 480) - 24,
            height: Math.min(Math.floor(vh / 3), 220),
          }),
          // Drop aspectRatio — letting the library pick the camera's
          // native ratio avoids the cropped-frame issue where part of
          // the barcode falls outside the visible feed on iOS Safari.
          disableFlip: false,
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

  const handleManualSubmit = (e) => {
    e?.preventDefault();
    const v = manualValue.trim();
    if (!v) return;
    onScan(v);
    setManualValue('');
    if (!continuous) {
      // Mirror the camera-decode behavior — close after one scan.
      closedRef.current = true;
      scannerRef.current?.stop().catch(() => {});
      onClose?.();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 pt-safe text-white bg-black/60">
        <Camera className="w-5 h-5" />
        <div className="flex-1 text-sm font-medium">
          {continuous ? 'Scan items continuously' : 'Scan box label'}
          {scans > 0 && <span className="text-xs text-white/60 ml-2">· {scans} read</span>}
        </div>
        <button
          onClick={() => setManualOpen(v => !v)}
          aria-label="Type code manually"
          className="p-2 rounded-lg hover:bg-white/10 active:bg-white/20"
        >
          <Keyboard className="w-5 h-5" />
        </button>
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
