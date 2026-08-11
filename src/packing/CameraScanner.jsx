import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Camera, Keyboard, Check, Plus, Minus, Flashlight, FlashlightOff } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat } from '@zxing/library';

// ZXing decode hints — only look for the formats we actually print
// (CODE128 for box labels, QR for item labels — swapped from CODE128
// because the tiny in-label barcode wouldn't print/scan reliably).
// Limiting POSSIBLE_FORMATS is the single biggest win for scan
// speed: by default ZXing tries every format it knows, which on a
// phone CPU is the main reason for the laggy decode the operator
// reported. TRY_HARDER intentionally left off — it's the opposite of
// speed.
const DECODE_HINTS = new Map();
DECODE_HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.CODE_128,
  BarcodeFormat.QR_CODE,
]);
// TRY_HARDER costs more CPU per frame but lets ZXing decode angled,
// slightly-out-of-focus, and partially-occluded barcodes that the
// fast path would miss. On modern phones the extra CPU is unnoticeable
// next to the camera pipeline itself — net win for accuracy.
DECODE_HINTS.set(DecodeHintType.TRY_HARDER, true);

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
  // Native BarcodeDetector + its requestAnimationFrame loop id. When
  // present, this path is ~10-30x faster than the JS @zxing decoder
  // because the browser hands the frame to the OS's hardware-accelerated
  // detector instead of running ZXing in JS on every frame.
  const detectorRef = useRef(null);
  const rafIdRef = useRef(0);

  const [err, setErr] = useState('');
  const [starting, setStarting] = useState(true);
  const [scans, setScans] = useState(0);
  const [manualValue, setManualValue] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  // Flash-on-decode for visible "we got it" feedback.
  const [success, setSuccess] = useState(false);
  // Zoom controls. Phones can't focus closer than ~4 inches; zooming
  // in lets the operator hold the phone further from the label
  // (where focus actually locks) and still fill the frame with the
  // barcode. Caps is null if the device doesn't expose zoom.
  const [zoomCaps, setZoomCaps] = useState(null);
  const [zoom, setZoom] = useState(1);
  // Torch (camera flash LED). When the label paper is colored (green
  // tints especially) the bg luma collapses toward the black barcode
  // bars and decoding stalls. The torch lifts the bg to near-white and
  // restores contrast. Only exposed when the device actually supports
  // the 'torch' constraint — most phones do, most laptops don't.
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Latest-callback refs so the decoder callback (set up once on
  // mount) always invokes the most recent version of onScan/onClose
  // when the parent re-renders.
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onScanRef.current = onScan;
    onCloseRef.current = onClose;
  });

  // Tear down everything we own — decoder, RAF loop, stream tracks,
  // video src. Called from the unmount cleanup and from the
  // synchronous part of the decode callback in one-shot mode.
  // Idempotent.
  const teardown = () => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
    detectorRef.current = null;
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

      // Best-effort camera tuning. Two things we try to set if the
      // device exposes them:
      //   - focusMode='continuous' so the barcode sharpens up as the
      //     operator moves the phone
      //   - zoom around 2x as a starting point — phones can't focus
      //     closer than ~4 inches, so zooming in lets the operator
      //     hold the phone further from the label (where focus actually
      //     locks) and still fill the frame
      try {
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack?.getCapabilities) {
          const caps = videoTrack.getCapabilities();
          const advanced = [];
          if (caps?.focusMode?.includes?.('continuous')) {
            advanced.push({ focusMode: 'continuous' });
          }
          if (caps?.zoom) {
            const initial = Math.min(2, caps.zoom.max ?? 2);
            advanced.push({ zoom: initial });
            setZoomCaps({
              min: caps.zoom.min ?? 1,
              max: caps.zoom.max ?? initial,
              step: caps.zoom.step ?? 0.5,
            });
            setZoom(initial);
          }
          // Torch capability — only on devices that expose it.
          // chromium-based phones report `caps.torch = true`; iOS Safari
          // sometimes reports it on iPhone but not iPad.
          if (caps?.torch) {
            setTorchSupported(true);
          }
          if (advanced.length) {
            await videoTrack.applyConstraints({ advanced });
          }
        }
      } catch { /* device-dependent; ignore */ }

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

      // Shared "we got a code" handler — wired by both decoder paths.
      const handleResult = (text) => {
        if (closedRef.current || !text) return;
        setScans((c) => c + 1);
        try {
          if (navigator.vibrate) navigator.vibrate(50);
        } catch { /* iOS Safari doesn't expose vibrate; ignore */ }
        setSuccess(true);
        closedRef.current = true;
        setTimeout(() => {
          teardown();
          onCloseRef.current?.();
          onScanRef.current(text);
        }, 350);
      };

      // Try the native BarcodeDetector first. Hardware-accelerated,
      // typically 10-30x faster than running @zxing in JS. Available on
      // Chrome (Android + desktop) and Safari iOS 17+. Firefox + older
      // browsers fall through to the @zxing path below.
      const supportsNative = typeof window !== 'undefined' && 'BarcodeDetector' in window;
      let nativeReady = false;
      if (supportsNative) {
        try {
          const supportedFormats = await window.BarcodeDetector.getSupportedFormats();
          const useFormats = ['code_128', 'qr_code'].filter(f => supportedFormats.includes(f));
          if (useFormats.length > 0) {
            const detector = new window.BarcodeDetector({ formats: useFormats });
            detectorRef.current = detector;
            // requestAnimationFrame loop runs at display refresh rate
            // (~60Hz) but detect() backpressures naturally — the next
            // frame only schedules after the current detect resolves.
            // Net: as fast as the device can decode, never overlapping.
            const loop = async () => {
              if (closedRef.current || cancelled) return;
              if (video.readyState >= 2) {
                try {
                  const codes = await detector.detect(video);
                  if (codes && codes.length > 0 && codes[0].rawValue) {
                    handleResult(codes[0].rawValue);
                    return;
                  }
                } catch { /* per-frame errors are non-fatal; keep looping */ }
              }
              rafIdRef.current = requestAnimationFrame(loop);
            };
            rafIdRef.current = requestAnimationFrame(loop);
            nativeReady = true;
            setStarting(false);
          }
        } catch { /* fall through to @zxing */ }
      }

      // @zxing fallback path. Runs entirely in JS; slower per frame
      // but works in every browser with getUserMedia.
      if (!nativeReady) {
        try {
          const controls = await reader.decodeFromVideoElement(
            video,
            (result) => { if (result) handleResult(result.getText()); },
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
      }
    })();

    return () => {
      cancelled = true;
      closedRef.current = true;
      teardown();
    };
  }, []);

  // Apply a new zoom level to the live MediaStream. Clamp to the
  // device's reported [min, max] so we don't trigger an OverconstrainedError.
  const applyZoom = async (next) => {
    if (!zoomCaps || !streamRef.current) return;
    const clamped = Math.max(zoomCaps.min, Math.min(zoomCaps.max, next));
    try {
      const track = streamRef.current.getVideoTracks()[0];
      await track.applyConstraints({ advanced: [{ zoom: clamped }] });
      setZoom(clamped);
    } catch { /* race during teardown; ignore */ }
  };

  // Flip the torch. The constraint sticks until we set it back to false
  // or tear down the stream; the camera teardown turns the LED off
  // automatically since releasing the track ends torch state.
  const toggleTorch = async () => {
    if (!torchSupported || !streamRef.current) return;
    const next = !torchOn;
    try {
      const track = streamRef.current.getVideoTracks()[0];
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch { /* device-dependent; ignore */ }
  };

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
        {torchSupported && (
          <button
            onClick={toggleTorch}
            aria-label={torchOn ? 'Turn torch off' : 'Turn torch on'}
            title={torchOn
              ? 'Torch on — turn off to save battery'
              : 'Turn on the camera light. Helps decode barcodes on tinted (green / colored) label stock.'}
            className={`p-2 rounded-lg active:bg-white/20 ${
              torchOn
                ? 'bg-amber-300 text-gray-900'
                : 'text-white hover:bg-white/10'
            }`}
          >
            {torchOn ? <Flashlight className="w-5 h-5" /> : <FlashlightOff className="w-5 h-5" />}
          </button>
        )}
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

        {/* Zoom controls — vertical column on the right side of the
            video. Phone cameras can't focus closer than ~4 inches;
            zooming in lets the operator hold the phone farther from
            the barcode (where focus locks) and still fill the frame.
            Only shown when the device exposes the zoom capability. */}
        {zoomCaps && zoomCaps.max > zoomCaps.min && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 bg-black/50 rounded-full px-1.5 py-2">
            <button
              type="button"
              onClick={() => applyZoom(zoom + (zoomCaps.step || 0.5))}
              disabled={zoom >= zoomCaps.max}
              aria-label="Zoom in"
              className="w-9 h-9 rounded-full bg-white/15 text-white flex items-center justify-center active:bg-white/30 disabled:opacity-40"
            >
              <Plus className="w-4 h-4" />
            </button>
            <div className="text-white text-xs font-mono py-0.5 tabular-nums">
              {zoom.toFixed(1)}×
            </div>
            <button
              type="button"
              onClick={() => applyZoom(zoom - (zoomCaps.step || 0.5))}
              disabled={zoom <= zoomCaps.min}
              aria-label="Zoom out"
              className="w-9 h-9 rounded-full bg-white/15 text-white flex items-center justify-center active:bg-white/30 disabled:opacity-40"
            >
              <Minus className="w-4 h-4" />
            </button>
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
            Tap <Keyboard className="w-3 h-3 inline -mt-0.5" /> to type instead
            {torchSupported && <>, <Flashlight className="w-3 h-3 inline -mt-0.5" /> for hard-to-read labels</>}.
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
