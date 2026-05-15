// Folia Bridge — local poller that drives an Android phone via ADB.
//
// Runs on the operator's Mac during a live sale. Polls the Folia API
// (Vercel) for jobs and executes them against a tethered Android phone.
// Outbound HTTPS only — no inbound ports, no tunnel, no certs.
//
// Required env (read from bridge/.env or the shell):
//   FOLIA_API_URL    e.g. https://foliainventory.vercel.app
//   BRIDGE_TOKEN     long-lived token from /api/bridge?action=generate-token
// Optional env:
//   BRIDGE_DEVICE    adb serial when multiple devices are connected
//   POLL_MS          poll interval in ms (default 500)
//   U2_URL           uiautomator2 server URL (default http://localhost:9008)
//                    Set to "off" to disable and fall back to `adb shell
//                    uiautomator dump` everywhere. The u2 server is ~7×
//                    faster per dump (~280 ms vs ~2 s) — well worth the
//                    one-time setup (`python -m uiautomator2 init`).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ─── Minimal .env loader (no dep) ───────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

const API_URL = (process.env.FOLIA_API_URL || '').replace(/\/$/, '');
const TOKEN = process.env.BRIDGE_TOKEN || '';
const DEVICE = process.env.BRIDGE_DEVICE || '';
const POLL_MS = parseInt(process.env.POLL_MS || '500', 10);
const U2_URL = (process.env.U2_URL ?? 'http://localhost:9008').replace(/\/$/, '');
const U2_ENABLED = U2_URL.toLowerCase() !== 'off';

if (!API_URL || !TOKEN) {
  console.error('Missing FOLIA_API_URL or BRIDGE_TOKEN. Create bridge/.env (see README).');
  process.exit(1);
}

const exec = promisify(execFile);

// ─── ADB wrappers ───────────────────────────────────────────────────────────

async function adb(...args) {
  const fullArgs = DEVICE ? ['-s', DEVICE, ...args] : args;
  try {
    const { stdout } = await exec('adb', fullArgs, { encoding: 'utf8', maxBuffer: 4 << 20 });
    return stdout;
  } catch (e) {
    throw new Error(`adb ${fullArgs.join(' ')} failed: ${(e.stderr || e.message || '').trim()}`);
  }
}
const adbShell = (...args) => adb('shell', ...args);

// uiautomator2 server's JSON-RPC `dumpWindowHierarchy` returns the
// same XML format as `uiautomator dump` but in ~280 ms instead of ~2 s
// (server is already running on-device, no per-call instrumentation
// spin-up). We keep using the slower ADB path as a fallback when the
// server isn't reachable so the bridge degrades gracefully.
async function u2Dump() {
  const r = await fetch(`${U2_URL}/jsonrpc/0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'dumpWindowHierarchy',
      params: [false],  // compressed=false; compressed strips too many nodes
    }),
  });
  if (!r.ok) throw new Error(`u2 dump HTTP ${r.status}`);
  const body = await r.json();
  if (body.error) throw new Error(`u2 dump: ${body.error.message}`);
  return body.result;
}

async function adbDump() {
  return adbShell('uiautomator dump --compressed /sdcard/ui.xml && cat /sdcard/ui.xml');
}

let u2Healthy = U2_ENABLED;
async function dumpUI() {
  if (u2Healthy) {
    try { return await u2Dump(); }
    catch (e) {
      console.warn(`[u2] dump failed (${e.message}); falling back to adb path`);
      u2Healthy = false;
    }
  }
  return adbDump();
}

function parseBounds(boundsAttr) {
  const m = (boundsAttr || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [, x1, y1, x2, y2] = m.map(Number);
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

// uiautomator dump emits XML entity escapes inside attribute values
// (e.g. `&amp;` for `&` in "Pin & Run"). We parse with a flat regex
// rather than a real XML parser, so callers' predicates would see the
// escaped form and never match natural strings — unescape on parse so
// predicates can compare against `'Pin & Run'` directly.
function unescapeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#xa;/gi, '\n');
}

function parseAttrs(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], unescapeXml(m[2])])
  );
}

function findNode(xml, predicate) {
  const matches = xml.match(/<node\s[^>]*>/g) || [];
  for (const tag of matches) {
    const attrs = parseAttrs(tag);
    if (predicate(attrs)) return attrs;
  }
  return null;
}

function findAllNodes(xml, predicate) {
  const matches = xml.match(/<node\s[^>]*>/g) || [];
  const out = [];
  for (const tag of matches) {
    const attrs = parseAttrs(tag);
    if (predicate(attrs)) out.push(attrs);
  }
  return out;
}

async function waitForNode(predicate, { timeoutMs = 5000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    const node = findNode(xml, predicate);
    if (node) return node;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function tap({ x, y, resourceId, text, contentDesc, timeoutMs }) {
  if (Number.isFinite(x) && Number.isFinite(y)) {
    await adbShell('input', 'tap', String(x), String(y));
    return { tapped: { x, y } };
  }
  if (resourceId || text || contentDesc) {
    const node = await waitForNode(
      a => (resourceId && a['resource-id'] === resourceId)
        || (text && a.text === text)
        || (contentDesc && a['content-desc'] === contentDesc),
      { timeoutMs: timeoutMs ?? 3000 }
    );
    if (!node) throw new Error(`node not found: ${resourceId || text || contentDesc}`);
    const b = parseBounds(node.bounds);
    if (!b) throw new Error('matched node has no bounds');
    await adbShell('input', 'tap', String(b.cx), String(b.cy));
    return { tapped: b };
  }
  throw new Error('tap needs x+y, resourceId, text, or contentDesc');
}

async function typeText(text) {
  if (typeof text !== 'string') throw new Error('text required');
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '%s')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
  await adbShell('input', 'text', escaped);
  return { length: text.length };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tapBoundsAttr(boundsAttr) {
  const b = parseBounds(boundsAttr);
  if (!b) throw new Error(`bad bounds: ${boundsAttr}`);
  await adbShell('input', 'tap', String(b.cx), String(b.cy));
  return b;
}

// Palmstreet "Quick listing" automation — title-only.
//
// During a live, scanning a SKU should open the Quick-listing form and
// pre-fill the plant name. The operator then sets price, quantity,
// image, and taps "Pin & Run" themselves. That split keeps the bridge
// simple, avoids the keyboard-shift complications around the price
// field, and gives the operator a final review before posting.
//
// Steps:
//   1. tap sidebar "Listing"
//   2. wait for the form to render (Pin & Run visible)
//   3. tap the title EditText (first EditText in form, by doc order)
//   4. wait ~400 ms for the soft keyboard to slide up
//   5. type the name
async function listing({ sku, name, grossCost }) {
  if (typeof name !== 'string' || !name) throw new Error('name required');
  // Title format on Palmstreet: "SKU - NAME". Operator scans during a
  // live to look up the inventory item later by SKU; the plant name
  // alone isn't unique. Bare name when sku is missing (shouldn't
  // happen in the Live Scan flow, but be defensive).
  const title = sku ? `${sku} - ${name}` : name;

  // Gross cost = what the operator paid for the item. Pre-fill into
  // the Starting Price field as a floor — they bid up from there
  // during the live. Round UP to the next whole dollar (Math.ceil)
  // so the starting bid is always at or above cost and there are no
  // awkward $9.46-style starting prices on a live auction.
  const startingPrice = grossCost != null && Number.isFinite(Number(grossCost))
    ? String(Math.ceil(Number(grossCost)))
    : null;

  // Tap on the live-video area to wake the host UI. The sidebar
  // (Flip / Listing / Shop / Support) auto-hides after a few idle
  // seconds and has to be revived before we can find Listing.
  // (540, 700) is empty video pixels — no-op when sidebar is already
  // visible. No explicit sleep after: the next dumpUI() waits for UI
  // idle on-device, so the sidebar slide-in animation finishes inside
  // that wait — saves ~400 ms of dead time per scan.
  await adbShell('input', 'tap', '540', '700');

  // Look up Listing by content-desc. We tried hardcoding the coords
  // for speed, but Palmstreet shifts the sidebar buttons up by ~130 px
  // when there's an actively pinned listing — a hardcoded tap landed
  // on Shop instead of Listing. Content-desc lookup is one dumpUI
  // (~1.5 s) slower but layout-independent.
  await tap({ contentDesc: 'Listing', timeoutMs: 3000 });

  // Wait for the form to render AND grab the EditTexts in the same
  // dump cycle. One round-trip vs. waitForNode then a second dumpUI.
  //
  // The u2 dump includes the host view's chat input EditText at the
  // bottom of the screen (~y=1862) even when the form modal is open,
  // because it's outside the modal but still in the same window. The
  // bridge used to silently tap that chat input instead of the title.
  // Filter EditTexts to those above the chat band (y2 < 1700) so we
  // only get the form's own fields.
  // Wait until BOTH title and price EditTexts are present in the dump.
  // Breaking at length>=1 used to fire on a transient mid-animation
  // state where only the title had rendered — bridge then typed the
  // title fine but skipped the price step because editTexts.length<2.
  // The y<1700 filter keeps only the form's title and price fields
  // (Quantity + Auction timer sit below that).
  let editTexts = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    if (findNode(xml, a => a['content-desc'] === 'Pin & Run')) {
      editTexts = findAllNodes(xml, a => {
        if (!(a.class || '').endsWith('EditText')) return false;
        const b = parseBounds(a.bounds);
        return b && b.y2 < 1700;
      });
      if (editTexts.length >= 2) break;
    }
    await sleep(200);
  }
  if (!editTexts || editTexts.length < 2) {
    throw new Error('listing form did not open (or rendered incompletely)');
  }

  await tapBoundsAttr(editTexts[0].bounds);
  await sleep(300);
  await typeText(title);

  // Dismiss the soft keyboard so the operator can immediately see the
  // price field below the title. With the keyboard up, KEYCODE_BACK
  // (4) only hides the keyboard — it doesn't close the Quick-listing
  // modal. Once dismissed, the layout returns to its no-keyboard
  // state, which is also the state captured in our editTexts[*]
  // bounds, so the second EditText (price) is back where we recorded
  // it and can be tapped directly.
  await adbShell('input', 'keyevent', '4');

  // Pre-fill the Starting Price with the item's net cost (when known).
  // Defaults in the form are "1" / "1" / "11"; clear before typing.
  let prefilled = ['title'];
  if (startingPrice && editTexts.length >= 2) {
    await sleep(200);  // brief beat for keyboard-dismiss animation
    await tapBoundsAttr(editTexts[1].bounds);
    await sleep(300);  // keyboard slides up again for the price field
    // MOVE_END + a handful of backspaces — overshooting on an empty
    // field is a no-op, so 8 is safe regardless of the default's length.
    await adbShell('input', 'keyevent', '123');
    for (let i = 0; i < 8; i++) await adbShell('input', 'keyevent', '67');
    await typeText(startingPrice);
    await adbShell('input', 'keyevent', '4');  // dismiss keyboard again
    prefilled.push('startingPrice');
  }

  return { sku, name, title, startingPrice, prefilled };
}

// ─── Job dispatch ───────────────────────────────────────────────────────────

async function handleJob(job) {
  switch (job.action) {
    case 'tap':
      return tap(job.payload || {});
    case 'type':
      return typeText(job.payload?.text);
    case 'dump':
      return { xml: await dumpUI() };
    case 'listing':
      return listing(job.payload || {});
    default:
      throw new Error(`unknown action: ${job.action}`);
  }
}

// ─── API client ─────────────────────────────────────────────────────────────

async function apiCall(path, init = {}) {
  const r = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const msg = body?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body;
}

const nextJob = () => apiCall('/api/bridge?action=next');
const completeJob = (id, result, error) =>
  apiCall('/api/bridge?action=complete', {
    method: 'POST',
    body: JSON.stringify({ action: 'complete', id, result, error }),
  });

// ─── Main loop ──────────────────────────────────────────────────────────────

let consecutiveErrors = 0;

async function pollOnce() {
  const { job } = await nextJob();
  if (!job) return;
  consecutiveErrors = 0;
  console.log(`[${new Date().toISOString()}] job ${job.id} (${job.action}) claimed`);
  let result = null, error = null;
  try {
    result = await handleJob(job);
  } catch (e) {
    error = e.message;
  }
  try {
    await completeJob(job.id, result, error);
    console.log(`[${new Date().toISOString()}] job ${job.id} ${error ? 'FAILED: ' + error : 'done'}`);
  } catch (reportErr) {
    // If we can't report the result, the job will eventually be re-claimed
    // by another bridge once it goes stale. Loud log so the operator sees it.
    console.error(`[${new Date().toISOString()}] failed to report job ${job.id}:`, reportErr.message);
  }
}

async function main() {
  console.log(`Folia bridge starting`);
  console.log(`  api    ${API_URL}`);
  console.log(`  device ${DEVICE || '(default adb device)'}`);
  console.log(`  poll   ${POLL_MS}ms`);

  // Sanity-check ADB up front so config issues surface immediately.
  try {
    const out = await adb('devices');
    const lines = out.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      console.warn('  ⚠ no ADB devices detected — plug in the phone or run `adb connect <ip>:5555`');
    } else {
      console.log(`  adb    ${lines.length} device(s): ${lines.join(', ')}`);
    }
  } catch (e) {
    console.warn(`  ⚠ adb not available: ${e.message}`);
  }

  while (true) {
    try {
      await pollOnce();
    } catch (e) {
      consecutiveErrors += 1;
      // Back off exponentially up to 30s when the API is unreachable
      // (Vercel cold start, network blip, token rotated, etc.).
      const backoff = Math.min(30_000, POLL_MS * 2 ** Math.min(consecutiveErrors, 5));
      console.error(`[${new Date().toISOString()}] poll error: ${e.message} (backing off ${backoff}ms)`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main();
