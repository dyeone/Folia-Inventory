import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Camera, Keyboard, Check } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat } from '@zxing/library';

// ZXing decode hints — only look for the formats we actually print
// (CODE128 for both box and item labels, QR as a fallback for future
// use). Limiting POSSIBLE_FORMATS is the single biggest win for scan
// speed: by default ZXing tries every format it knows, which on a
// phone CPU is the main reason for the laggy decode the operator
// reported. TRY_HARDER intentionally left off — it's the opposite of
// speed.
const DECODE_HINTS = new Map();
DECODE_HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.CODE_128,
  BarcodeFormat.QR_CODE,
]);

// Direct @zxing/browser implementation — replaces the html5-qrcode
// wrapper that was hanging iOS Safari on stream release. We own the
// video element, the MediaStream, and the decoder loop so the
// teardown order is predictable.
//
// Always one-shot: camera opens, decodes one barcode, fires onScan
// with the text, and closes. The packer taps the Camera button again
// to scan the next item. Removing continuous mode removes the
// per-scan state-sync complexity (stale closures, debounce timing,
// auto-close UX) that was misbehaving on iPhones.

export function CameraScanner({ onScan, onClose }) {
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null);
  const streamRef = useRef(null);
  const closedRef = useRef(false);

  const [err, setErr] = useState('');
  const [starting, setStarting] = useState(true);
  const [scans, setScans] = useState(0);
  const [manualValue, setManualValue] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  // Flash-on-decode for visible "we got it" feedback.
  const [success, setSuccess] = useState(false);

  // Latest-callback refs so the decoder callback (set up once on
  // mount) always invokes the most recent version of onScan/onClose
  // when the parent re-renders.
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onScanRef.current = onScan;
    onCloseRef.current = onClose;
  });

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

    // Constructor takes (hints, options). Setting
    // timeBetweenScansMillis low makes decode attempts happen more
    // often per second — combined with the format whitelist above,
    // CODE128 locks on noticeably faster.
    const reader = new BrowserMultiFormatReader(DECODE_HINTS, {
      delayBetweenScanAttempts: 100,
      delayBetweenScanSuccess: 100,
    });
    readerRef.current = reader;

    (async () => {
      let stream;
      try {
        // 720p is plenty for CODE128 / QR at typical phone-to-label
        // distance and decodes meaningfully faster than the default
        // (often 1080p / 4K on modern iPhones) because each frame is
        // ~4× smaller for ZXing to chew through.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
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

            // Feedback: vibrate (mobile) + flash the scan area green.
            try {
              if (navigator.vibrate) navigator.vibrate(50);
            } catch { /* iOS Safari doesn't expose vibrate; ignore */ }
            setSuccess(true);

            // Lock further decodes immediately so a second frame
            // doesn't trigger again while the flash is showing.
            closedRef.current = true;
            // Hold the flash visible for ~350ms so the operator
            // actually sees "we got it" before we tear down the
            // camera and fire the scan callback.
            setTimeout(() => {
              teardown();
              onCloseRef.current?.();
              onScanRef.current(text);
            }, 350);
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
  }, []);

  const handleManualSubmit = (e) => {
    e?.preventDefault();
    const v = manualValue.trim();
    if (!v) return;
    closedRef.current = true;
    teardown();
    onCloseRef.current?.();
    onScanRef.current(v);
    setManualValue('');
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 pt-safe text-white bg-black/60">
        <Camera className="w-5 h-5" />
        <div className="flex-1 text-sm font-medium">
          Scan a barcode
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
          onClick={() => { closedRef.current = true; teardown(); onCloseRef.current?.(); }}
          aria-label="Close camera"
          className="p-2 -mr-1 rounded-lg hover:bg-white/10 active:bg-white/20"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 relative bg-black overflow-hidden">
        {/* Own video element — we control its lifecycle, not a wrapper lib. */}
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          autoPlay
          playsInline
          muted
        />

        {/* Scan-target overlay: corner brackets frame the area where
            the operator should aim the barcode, and a sweeping
            emerald line moves vertically to suggest "I am actively
            scanning". Pointer-events-none so it doesn't block
            interactions with the buttons in the header. */}
        {!starting && !err && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className={`relative w-[78%] max-w-sm h-32 transition-colors duration-200 ${
              success ? 'border-2 border-emerald-400 rounded-lg' : ''
            }`}>
              {/* Four corner brackets */}
              <div className="absolute -top-1 -left-1 w-7 h-7 border-t-4 border-l-4 border-emerald-400 rounded-tl-lg" />
              <div className="absolute -top-1 -right-1 w-7 h-7 border-t-4 border-r-4 border-emerald-400 rounded-tr-lg" />
              <div className="absolute -bottom-1 -left-1 w-7 h-7 border-b-4 border-l-4 border-emerald-400 rounded-bl-lg" />
              <div className="absolute -bottom-1 -right-1 w-7 h-7 border-b-4 border-r-4 border-emerald-400 rounded-br-lg" />

              {/* Sweeping laser line — hidden during success flash so
                  it doesn't compete visually with the checkmark. */}
              {!success && (
                <div className="folia-scan-line absolute left-2 right-2 h-[2px] bg-emerald-400 shadow-[0_0_12px_2px_rgba(52,211,153,0.85)]" />
              )}

              {/* Success: green flood + checkmark pop. */}
              {success && (
                <div className="folia-scan-success absolute inset-0 flex items-center justify-center rounded-lg bg-emerald-500/40 backdrop-blur-[1px]">
                  <Check className="w-16 h-16 text-white drop-shadow-lg" strokeWidth={3} />
                </div>
              )}
            </div>
          </div>
        )}

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
              placeholder="Code or SKU"
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
          Point at the barcode. Camera closes after one scan.
          <div className="mt-1 text-white/50">
            Tap <Keyboard className="w-3 h-3 inline -mt-0.5" /> to type instead.
          </div>
        </div>
      )}
      {/* Scoped keyframes for the scan-line sweep + success pop.
          Inline so the component is self-contained — no global CSS to
          remember to update when this view is removed. */}
      <style>{`
        @keyframes folia-scan-sweep {
          0%   { top: 0;    opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { top: 100%; opacity: 0; }
        }
        .folia-scan-line {
          animation: folia-scan-sweep 1.6s ease-in-out infinite;
        }
        @keyframes folia-scan-success-pop {
          0%   { opacity: 0; transform: scale(0.7); }
          40%  { opacity: 1; transform: scale(1.05); }
          100% { opacity: 1; transform: scale(1); }
        }
        .folia-scan-success {
          animation: folia-scan-success-pop 0.25s ease-out;
        }
      `}</style>
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
