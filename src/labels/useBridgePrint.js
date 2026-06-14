import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// One-click direct printing through the local Folia Bridge (the Mac app).
//
// Instead of popping the browser's print dialog, the web builds the label PDF
// (jsPDF, exactly as before), base64-encodes it, and enqueues a `print` job on
// the same durable bridge queue that drives Palmstreet. The bridge writes the
// PDF to a temp file and runs macOS `lp` to the operator's configured printer.
//
// This module is the web half: a health poll so callers can tell whether the
// bridge is reachable (and fall back to browser print when it isn't), and a
// promise that enqueues a print job and resolves once the bridge reports done.

// jsPDF → base64 with no `data:` prefix — the form the bridge decodes via
// Buffer.from(b64, 'base64'). `datauristring` is stable across jsPDF versions;
// its only comma separates the header from the payload.
export function pdfToBase64(pdf) {
  const uri = pdf.output('datauristring');
  return uri.slice(uri.indexOf(',') + 1);
}

// Label PDFs are a few KB; this only guards against an accidental giant (the
// base64 rides through the Vercel enqueue request and lands in bridge_jobs).
const MAX_PDF_BASE64 = 3_000_000; // ~2.2 MB of binary

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a single print job to a terminal state. The bridge's status poll has no
// built-in timeout (see LiveScanModal), so we add one here — a print that never
// reports back means the bridge died mid-job, and the caller should fall back
// to browser print rather than spin forever. isCancelled() lets the caller stop
// the loop early (e.g. the sheet was closed) so we don't keep hitting the
// network — it resolves to { cancelled: true } instead of a result.
async function pollPrintJob(jobId, isCancelled = () => false, { timeoutMs = 35_000, intervalMs = 1200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCancelled()) return { cancelled: true };
    await sleep(intervalMs);
    if (isCancelled()) return { cancelled: true };
    let jobs;
    try {
      jobs = await api.bridgeStatus([jobId]);
    } catch {
      continue; // transient network blip — keep polling
    }
    const job = jobs?.find((j) => j.id === jobId);
    if (!job) continue;
    if (job.status === 'done') return job.result || {};
    if (job.status === 'failed') throw new Error(job.error || 'Print failed at the bridge');
  }
  throw new Error('Print timed out — is the Folia Bridge (Mac app) running?');
}

export function useBridgePrint() {
  // null = not yet known; true/false once the first health check returns.
  const [bridgeOnline, setBridgeOnline] = useState(null);
  const [printing, setPrinting] = useState(false);
  // Flipped on unmount so an in-flight print stops polling and skips state
  // updates once the sheet has closed.
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const h = await api.bridgeHealth();
        if (!cancelled) setBridgeOnline(!!h?.online);
      } catch {
        if (!cancelled) setBridgeOnline(false);
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Enqueue a print job and resolve once the bridge has spooled it. Resolves to
  // { cancelled: true } if the sheet closed mid-print; throws on bridge failure
  // / timeout / oversized PDF so the caller can fall back to browser print.
  const printViaBridge = useCallback(async ({ pdfBase64, role, copies = 1, media } = {}) => {
    if (!pdfBase64) throw new Error('Nothing to print');
    if (pdfBase64.length > MAX_PDF_BASE64) throw new Error('PDF too large to print via bridge');
    setPrinting(true);
    try {
      const job = await api.bridgePrint({ pdfBase64, role, copies, media });
      return await pollPrintJob(job.id, () => unmountedRef.current);
    } finally {
      if (!unmountedRef.current) setPrinting(false);
    }
  }, []);

  return { bridgeOnline, printing, printViaBridge };
}

// How many label pages to put in a single print job. The base64 PDF rides
// through the Vercel enqueue request (~4.5 MB body cap) and lands in
// bridge_jobs, so a big batch (e.g. 120 labels) can't go in one job. Split it
// into chunks small enough to fit and print each as its own job, in order.
// 60 stays well under the cap even if the PDF doesn't compress (worst case
// ~1.5 MB base64) while keeping the job count low for typical batches.
const LABELS_PER_JOB = 60;

// Build + print an array of items via the bridge, one job per chunk so any
// batch size fits under the request-size cap. buildPdf(chunk) builds a PDF for
// just that slice; printViaBridge comes from useBridgePrint. Jobs run in order
// (await each) so the labels come out in sequence. Returns the printer name, or
// { cancelled: true } if the sheet closed mid-run. Throws on the first failure.
export async function printChunked({ items, buildPdf, role, printViaBridge, chunkSize = LABELS_PER_JOB, media }) {
  let printer;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const pdf = await buildPdf(chunk);
    const res = await printViaBridge({ pdfBase64: pdfToBase64(pdf), role, media });
    if (res?.cancelled) return { cancelled: true };
    printer = res.printer;
  }
  return { printer };
}

// Auto-print on open. When a print sheet mounts and the bridge is online, print
// directly and close — skipping the preview entirely (operators asked to just
// print, not eyeball a grid first). Falls back to the full preview UI when the
// bridge is offline or the direct print fails, so they can review / browser-
// print / retry. `printDirect(printViaBridge)` does the actual print (usually
// printChunked); it should resolve to { printer } or { cancelled }, or throw.
// The sheet renders from the returned `phase`:
//   'checking'  bridge health unknown — show a tiny connecting overlay
//   'printing'  direct print in flight — show a tiny printing overlay
//   'done'      printed; onClose has fired (sheet is unmounting)
//   'preview'   show the full preview UI (offline, or a direct-print error)
export function useAutoBridgePrint({ printDirect, onClose, showToast }) {
  const { bridgeOnline, printViaBridge } = useBridgePrint();
  const [phase, setPhase] = useState('checking');
  const [error, setError] = useState(null);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || bridgeOnline === null) return; // wait for first health result
    // Latch only when we actually start printing (online). If the bridge is
    // offline at open, show the preview but stay UNLATCHED, so we still auto-
    // print if it comes online while the sheet is open — otherwise a transient
    // first-health 'offline' leaves the sheet stuck on the grid even after the
    // chip flips to "Printer ready".
    if (bridgeOnline === true) fired.current = true;
    let cancelled = false;
    // All state updates live inside this async fn (never synchronously in the
    // effect body) so they run after an await, mirroring the health-poll effect.
    (async () => {
      if (!bridgeOnline) { if (!cancelled) setPhase('preview'); return; } // offline → manual preview
      if (!cancelled) setPhase('printing');
      try {
        const res = await printDirect(printViaBridge);
        if (cancelled || res?.cancelled) return; // sheet closed mid-print
        setPhase('done');
        showToast?.(`Sent to ${res?.printer || 'printer'}`);
        onClose?.();
      } catch (e) {
        if (!cancelled) { setError(`Printer error: ${e.message}`); setPhase('preview'); } // browser-print / retry from the preview
      }
    })();
    return () => { cancelled = true; };
    // Runs once when the first health result lands; the `fired` guard makes the
    // other referenced values (printDirect/printViaBridge/…) safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeOnline]);

  return { phase, error };
}
