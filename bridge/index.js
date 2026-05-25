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
//   POLL_MS          sleep between /next requests (default 50ms).
//                    /next now long-polls server-side for up to ~9s,
//                    so this is just a tiny breather between cycles —
//                    not the actual polling rate.
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
const POLL_MS = parseInt(process.env.POLL_MS || '50', 10);
const U2_URL = (process.env.U2_URL ?? 'http://localhost:9008').replace(/\/$/, '');
const U2_ENABLED = U2_URL.toLowerCase() !== 'off';

if (!API_URL || !TOKEN) {
  console.error('Missing FOLIA_API_URL or BRIDGE_TOKEN. Create bridge/.env (see README).');
  process.exit(1);
}

// Multi-device guard. Without BRIDGE_DEVICE set, every adb call falls
// back to "use the only connected device" — which silently breaks the
// moment USB + Wireless ADB are both attached (a very common setup
// because operators plug in for charging). Detect that up front and
// fail loudly instead of letting downstream `input tap` calls error
// with the cryptic "more than one device/emulator" message.
{
  const devices = (() => {
    try {
      const out = require('node:child_process')
        .execFileSync('adb', ['devices'], { encoding: 'utf8' });
      return out.split('\n')
        .slice(1)
        .map(l => l.split('\t')[0])
        .filter(s => s && /\S/.test(s));
    } catch { return []; }
  })();
  if (devices.length > 1 && !DEVICE) {
    console.error(
      `✗ ${devices.length} adb devices connected and BRIDGE_DEVICE not set.\n` +
      `  Connected: ${devices.join(', ')}\n` +
      `  Run bridge/start.sh (clears wireless transports and pins the\n` +
      `  USB serial automatically), or set BRIDGE_DEVICE=<serial> in\n` +
      `  bridge/.env manually.`,
    );
    process.exit(1);
  }
  if (DEVICE) {
    console.log(`→ Bridge pinned to device ${DEVICE}`);
  }
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

// u2 server can die mid-session (device sleep, USB blip, Palmstreet UI
// churn). The original code latched u2Healthy=false on first failure
// for the bridge's lifetime, which meant a single dropped u2 call would
// pin the whole session to the ~2 s adb-dump path. Now we periodically
// re-probe u2 when in fallback mode and flip back to the fast path on
// success, so the bridge self-heals without a restart.
let u2Healthy = U2_ENABLED;
let u2RetryAfter = 0;
const U2_RETRY_INTERVAL_MS = 60_000;

async function dumpUI() {
  if (u2Healthy) {
    try { return await u2Dump(); }
    catch (e) {
      console.warn(`[u2] dump failed (${e.message}); falling back to adb path`);
      u2Healthy = false;
      u2RetryAfter = Date.now() + U2_RETRY_INTERVAL_MS;
    }
  } else if (U2_ENABLED && Date.now() >= u2RetryAfter) {
    try {
      const result = await u2Dump();
      console.log(`[u2] recovered — switching back to fast path`);
      u2Healthy = true;
      return result;
    } catch {
      u2RetryAfter = Date.now() + U2_RETRY_INTERVAL_MS;
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
  // `adb shell` rejoins our argv with spaces and re-runs it through
  // the device's `sh -c`, so shell metacharacters in the text (parens,
  // &, $, etc.) cause syntax errors before `input text` ever sees them.
  // Single-quote the argument: inside single quotes the device shell
  // preserves everything except a single quote, which we handle by
  // closing the quote, escaping, and reopening.
  //   %s is `input text`'s own escape for a space, so we still convert
  //   spaces before wrapping (single quotes don't help with that since
  //   the issue is `input text`'s parser, not the shell's).
  const inputArg = text.replace(/ /g, '%s');
  const shellArg = "'" + inputArg.replace(/'/g, "'\\''") + "'";
  await adbShell('input', 'text', shellArg);
  return { length: text.length };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tapBoundsAttr(boundsAttr) {
  const b = parseBounds(boundsAttr);
  if (!b) throw new Error(`bad bounds: ${boundsAttr}`);
  await adbShell('input', 'tap', String(b.cx), String(b.cy));
  return b;
}

// Palmstreet's Android package name. The user-facing app is called
// "Palmstreet", but its package is published under the original
// developer's namespace — neither "palmstreet" nor "popshop" appears
// in it. Update this constant if Palmstreet ever republishes the app
// under a new package id.
const PALMSTREET_PACKAGE = 'com.touchberry.plant.story.identification.gardening';

// Ask Android which window currently has focus. If it isn't Palmstreet,
// we can't drive the listing form — the operator pushed the app to the
// background, or a system dialog stole focus. Surface a clear message
// instead of the generic "node not found: Listing" / "form did not
// open" errors that don't tell the operator what to fix.
async function checkPalmstreetForeground() {
  let focus;
  try {
    focus = (await adbShell('dumpsys window | grep mCurrentFocus')).trim();
  } catch {
    return; // best-effort diagnostic only — don't mask a real error
  }
  if (focus && !focus.includes(PALMSTREET_PACKAGE)) {
    throw new Error('Palmstreet is not in the foreground — open the Palmstreet app on the phone, then re-scan');
  }
}

// Locate the Quick-listing form's Starting Price EditText by anchoring
// to the "Starting Price" content-desc View that sits to its left. More
// robust than position-in-document-order: the title field above can
// wrap to two lines on long names, which shifts the price down out of
// the (cached) bounds we captured at form-open.
function findPriceField(xml) {
  const label = findNode(xml, a => a['content-desc'] === 'Starting Price');
  if (!label) return null;
  const lb = parseBounds(label.bounds);
  if (!lb) return null;
  // Same-row EditText: vertical center inside the label's y-range,
  // give or take a few pixels for half-row alignment differences.
  const SLOP = 30;
  const candidates = findAllNodes(xml, a => {
    if (!(a.class || '').endsWith('EditText')) return false;
    const b = parseBounds(a.bounds);
    if (!b) return false;
    return b.cy >= lb.y1 - SLOP && b.cy <= lb.y2 + SLOP;
  });
  return candidates[0] || null;
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

  // Open the listing form and grab the title+price EditTexts in one go.
  // Factored so we can retry once if the first attempt fails — the
  // "Listing" sidebar item is a toggle, so if a previous form was still
  // half-dismissed when the next scan arrives, the first tap can close
  // it instead of opening it. Retrying re-opens.
  //
  // The flow each attempt:
  //   1. Wake-tap empty video at (540, 700) so the auto-hidden sidebar
  //      slides back in. No-op when sidebar is already showing.
  //   2. Find "Listing" by content-desc (layout-independent — coords
  //      shift ~130 px when a listing is pinned).
  //   3. Wait up to `formDeadlineMs` for the form to render. "Rendered"
  //      means "Pin & Run" content-desc is present AND both the title
  //      and price EditTexts are visible (y2 < 1700 to filter out the
  //      host view's chat-input EditText). Both must be present in the
  //      same dump cycle — a mid-animation state where only the title
  //      had rendered used to fire and silently skip the price step.
  async function openFormAndGrabFields(formDeadlineMs) {
    await adbShell('input', 'tap', '540', '700');
    // Wide timeout: when a listing has just sold, Palmstreet briefly
    // animates a "SOLD" celebration overlay that can hide the sidebar
    // for several seconds. 8 s rides through that animation; success
    // path still resolves on the first dump (~280 ms) so this doesn't
    // hurt happy-path latency.
    await tap({ contentDesc: 'Listing', timeoutMs: 8000 });
    const deadline = Date.now() + formDeadlineMs;
    while (Date.now() < deadline) {
      const xml = await dumpUI();
      if (findNode(xml, a => a['content-desc'] === 'Pin & Run')) {
        const fields = findAllNodes(xml, a => {
          if (!(a.class || '').endsWith('EditText')) return false;
          const b = parseBounds(a.bounds);
          return b && b.y2 < 1700;
        });
        if (fields.length >= 2) return fields;
      }
      await sleep(200);
    }
    return null;
  }

  // Pre-check: is the form already open from a previous scan that the
  // operator hasn't pinned yet? If so, the sidebar is hidden behind it,
  // so tapping "Listing" would fail with "node not found" — but we don't
  // need to tap Listing at all. Just grab the existing EditTexts and
  // type the new values over the old. Skips one dump+two taps on the
  // happy path of back-to-back scans.
  function grabFieldsIfOpen(xml) {
    if (!findNode(xml, a => a['content-desc'] === 'Pin & Run')) return null;
    const fields = findAllNodes(xml, a => {
      if (!(a.class || '').endsWith('EditText')) return false;
      const b = parseBounds(a.bounds);
      return b && b.y2 < 1700;
    });
    return fields.length >= 2 ? fields : null;
  }

  // Wrap the form-open attempts so any failure (form didn't render,
  // "node not found: Listing" thrown from tap(), etc.) gets a final
  // diagnostic pass for Palmstreet being foregrounded. Without this,
  // a backgrounded app surfaces as a cryptic node-not-found error.
  async function openOrDiagnose() {
    try {
      let fields = grabFieldsIfOpen(await dumpUI());
      if (!fields) fields = await openFormAndGrabFields(5000);
      if (!fields) {
        console.warn(`[${new Date().toISOString()}] listing form didn't render — retrying once`);
        fields = await openFormAndGrabFields(3500);
      }
      if (fields) return fields;
    } catch (e) {
      await checkPalmstreetForeground();
      throw e;
    }
    await checkPalmstreetForeground();
    throw new Error('listing form did not open (or rendered incompletely)');
  }
  const editTexts = await openOrDiagnose();

  await tapBoundsAttr(editTexts[0].bounds);
  await sleep(220);
  // Clear any existing title text from a previous scan. Back-to-back
  // scans (pre-check skipped the wake/Listing flow because the form
  // was still open) would otherwise append the new title onto the old.
  // Only fire when the field actually has content, and size the
  // overshoot to the existing length + 5. Skipping when empty saves
  // ~200 ms on every open-from-scratch scan.
  const priorTitle = editTexts[0].text || '';
  if (priorTitle.length > 0) {
    const backspaces = Array(priorTitle.length + 5).fill('67');
    await adbShell('input', 'keyevent', '123', ...backspaces);
  }
  await typeText(title);

  // Dismiss the soft keyboard so the operator can immediately see the
  // price field below the title. With the keyboard up, KEYCODE_BACK
  // (4) only hides the keyboard — it doesn't close the Quick-listing
  // modal.
  await adbShell('input', 'keyevent', '4');

  // Pre-fill the Starting Price with the item's gross cost (rounded up).
  // Defaults in the form are "1" / "1" / "11"; clear before typing.
  //
  // The title field has a 0/60 counter and grows downward when a long
  // title wraps to a second line, shifting the Starting Price field
  // below the bounds we captured at form-open. So we re-dump after
  // dismissing the keyboard and anchor to the "Starting Price"
  // content-desc View label (always on the left of the price input)
  // rather than relying on cached bounds.
  let prefilled = ['title'];
  if (startingPrice) {
    // Try to find the label-anchored Starting Price field. Retry for up
    // to ~5 s — back-to-back scans can leave the form in a transient
    // re-render state where the label is briefly absent from the dump.
    let priceTarget = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(120);
      const found = findPriceField(await dumpUI());
      if (found) { priceTarget = found.bounds; break; }
    }
    // Fallback: if the label still isn't in the dump, re-dump and take
    // the second EditText with y2<1700 from the FRESH tree. We can't
    // use the editTexts captured at form-open: if the title wrapped to
    // two lines after we typed it, every field below it shifted down,
    // and the cached bounds for editTexts[1] now point at where the
    // title's second line is — typing the price there would put the
    // digits in the title field. A fresh dump's editTexts[1] has the
    // current bounds.
    if (!priceTarget) {
      const xmlFresh = await dumpUI();
      const freshEditTexts = findAllNodes(xmlFresh, a => {
        if (!(a.class || '').endsWith('EditText')) return false;
        const b = parseBounds(a.bounds);
        return b && b.y2 < 1700;
      });
      if (freshEditTexts.length >= 2) {
        console.warn(`[${new Date().toISOString()}] Starting Price label not found — using fresh editTexts[1]`);
        priceTarget = freshEditTexts[1].bounds;
      }
    }
    if (priceTarget) {
      await tapBoundsAttr(priceTarget);
      await sleep(220);  // keyboard slides up for the price field
      // MOVE_END + 8 backspaces in a single adb call. `input keyevent`
      // accepts a variadic keycode list, so one round-trip clears the
      // field instead of nine. Overshooting on a 1- or 2-digit default
      // is a no-op, so 8 is safe regardless of the default's length.
      await adbShell('input', 'keyevent', '123', '67', '67', '67', '67', '67', '67', '67', '67');
      await typeText(startingPrice);
      await adbShell('input', 'keyevent', '4');  // dismiss keyboard again
      prefilled.push('startingPrice');
    } else {
      console.warn(`[${new Date().toISOString()}] couldn't locate Starting Price field after title — leaving default`);
    }
  }

  return { sku, name, title, startingPrice, prefilled };
}

// ─── Job dispatch ───────────────────────────────────────────────────────────

function runJob(job) {
  switch (job.action) {
    case 'tap':
      return tap(job.payload || {});
    case 'type':
      return typeText(job.payload?.text);
    case 'dump':
      return dumpUI().then(xml => ({ xml }));
    case 'listing':
      return listing(job.payload || {});
    default:
      return Promise.reject(new Error(`unknown action: ${job.action}`));
  }
}

// "no devices/emulators found" is what adb prints when the phone has
// momentarily dropped off the USB bus (cable jiggle, hub power blip,
// phone slept briefly). Don't blow the whole job — wait for the device
// to come back, then retry once. `adb wait-for-device` blocks until at
// least one device is connected, with a hard cap so we don't sit there
// forever if the operator gave up and unplugged the phone.
function isDeviceGoneError(err) {
  return /no devices\/emulators found|device offline|device not found|device '\S+' not found/i
    .test(err?.message || '');
}

async function waitForDeviceWithTimeout(timeoutMs) {
  await Promise.race([
    adb('wait-for-device'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('device did not return within ' + timeoutMs + 'ms')), timeoutMs)),
  ]);
}

async function handleJob(job) {
  try {
    return await runJob(job);
  } catch (e) {
    if (!isDeviceGoneError(e)) throw e;
    console.warn(`[${new Date().toISOString()}] device dropped mid-job (${e.message}); waiting up to 10s for reconnect…`);
    try {
      await waitForDeviceWithTimeout(10_000);
    } catch (waitErr) {
      throw new Error(`${e.message} (and ${waitErr.message})`);
    }
    console.log(`[${new Date().toISOString()}] device back — retrying job ${job.id}`);
    return runJob(job);
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
