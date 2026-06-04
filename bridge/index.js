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

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// back to "use the only connected device" — ambiguous and fragile when
// more than one phone is plugged in. Detect up front and fail loudly
// instead of letting downstream `input tap` errors surface as the
// cryptic "more than one device/emulator" message.
{
  const devices = (() => {
    try {
      const out = execFileSync('adb', ['devices'], { encoding: 'utf8' });
      // Rows are "serial\tstatus". Count only fully-attached devices —
      // ignore "offline"/"unauthorized"/"no permissions" entries so a
      // half-connected second phone doesn't trip the guard.
      return out.split('\n')
        .slice(1)
        .map(l => l.split('\t'))
        .filter(([serial, status]) => serial && /\S/.test(serial) && status?.trim() === 'device')
        .map(([serial]) => serial);
    } catch { return []; }
  })();
  if (devices.length > 1 && !DEVICE) {
    console.error(
      `✗ ${devices.length} adb devices connected and BRIDGE_DEVICE not set.\n` +
      `  Connected: ${devices.join(', ')}\n` +
      `  Set BRIDGE_DEVICE=<serial> in bridge/.env to pin one.`,
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

// In-place u2 server relaunch — same command the README documents for
// post-reboot recovery, and the same recovery reconnect.sh performs.
const U2_RELAUNCH_CMD =
  "nohup sh -c 'CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main' > /dev/null 2>&1 &";
// The server takes ~2-3 s to bind port 9008 (setup.sh/reconnect.sh budget
// up to 8 s). A fixed 800 ms sleep then a single retry — what this used to
// do — almost always fired before the port was listening, so the in-place
// relaunch "failed" and the bridge dropped to the slow/unhealthy path for
// nothing. Instead, poll until the server answers (returns on the first
// success, so the happy path stays fast) up to a real bind timeout.
const U2_BIND_TIMEOUT_MS = 6000;
const U2_BIND_PROBE_MS = 300;

// Kill any stale server, re-establish the host-side forward, re-exec the
// JAR, then poll u2Dump() until it answers. Returns that first successful
// dump so the caller doesn't re-probe. Throws if the server never binds.
async function relaunchU2() {
  try { await adbShell('pkill', '-f', 'com.wetest.uia2'); } catch { /* nothing to kill */ }
  // Let the old process release port 9008 before the new one rebinds —
  // both shell scripts sleep 1 s here for the same reason.
  await new Promise(r => setTimeout(r, 1000));
  // A USB blip / re-enumeration commonly drops the host `adb forward`,
  // which is the real reason u2 became unreachable. reconnect.sh
  // re-forwards on every recovery; do the same (best-effort) so a dropped
  // forward self-heals without the operator clicking "Reconnect phone".
  try { await adb('forward', 'tcp:9008', 'tcp:9008'); } catch { /* may already be live */ }
  await adbShell(U2_RELAUNCH_CMD);
  const deadline = Date.now() + U2_BIND_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, U2_BIND_PROBE_MS));
    try { return await u2Dump(); }
    catch (e) { lastErr = e; }
  }
  throw new Error(`u2 did not bind within ${U2_BIND_TIMEOUT_MS}ms${lastErr ? ` (${lastErr.message})` : ''}`);
}

// u2 server can die mid-session (device sleep, USB blip, Palmstreet UI
// churn). The bridge tries to self-heal in two ways:
//
//  1. On first failure of a previously-healthy server, attempt an
//     in-place relaunch (same command the README documents). Avoids
//     30+ s of degraded operation when u2 just needs a kick. Critical
//     on Android 16+, where the adb-shell `uiautomator dump` fallback
//     is broken (the shell binary gets SIGKILL'd by the platform).
//  2. If the relaunch also fails, mark u2 unhealthy and re-probe every
//     U2_RETRY_INTERVAL_MS so the bridge flips back to the fast path
//     once u2 returns on its own.
//
// adbDump() stays as a last-resort fallback for older Android versions
// where `uiautomator dump` still works.
let u2Healthy = U2_ENABLED;
let u2RetryAfter = 0;
let u2Backoff = 0;
// Escalating retry: don't sit on the slow path for a fixed 60 s when u2
// often comes back within seconds. Start at 3 s, double to a 60 s ceiling.
const U2_RETRY_MIN_MS = 3_000;
const U2_RETRY_MAX_MS = 60_000;

function markU2Unhealthy() {
  u2Healthy = false;
  u2Backoff = u2Backoff ? Math.min(u2Backoff * 2, U2_RETRY_MAX_MS) : U2_RETRY_MIN_MS;
  u2RetryAfter = Date.now() + u2Backoff;
}

function markU2Recovered(label) {
  if (!u2Healthy) console.log(`[u2] ${label} — back on fast path`);
  u2Healthy = true;
  u2Backoff = 0;
}

async function dumpUI() {
  if (u2Healthy) {
    try { return await u2Dump(); }
    catch (e) {
      console.warn(`[u2] dump failed (${e.message}); attempting in-place relaunch`);
      try {
        const result = await relaunchU2();  // re-forwards, re-execs, polls until bound
        console.log('[u2] relaunched in-place; resuming fast path');
        u2Backoff = 0;
        return result;
      } catch (e2) {
        console.warn(`[u2] in-place relaunch failed (${e2.message}); falling back to adb path`);
        markU2Unhealthy();
      }
    }
  } else if (U2_ENABLED && Date.now() >= u2RetryAfter) {
    // Cheap probe first, in case u2 came back on its own…
    try {
      const result = await u2Dump();
      markU2Recovered('recovered');
      return result;
    } catch { /* still down — actively re-kick it below */ }
    // …a server that truly died won't return without a relaunch, so do
    // one here rather than only passively pinging a dead port forever.
    try {
      const result = await relaunchU2();
      markU2Recovered('re-kicked');
      return result;
    } catch {
      markU2Unhealthy();
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
// (e.g. `&amp;` for `&` in a listing title, and `&#10;` for the newlines
// in a multiline content-desc like "Buy Now\nTab 2 of 3"). We parse with
// a flat regex rather than a real XML parser, so callers' predicates
// would see the escaped form and never match natural strings — unescape
// on parse so predicates (and descFirstLine) compare against real text.
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

// Palmstreet builds many controls with a multiline content-desc whose
// first line is the human label and the rest is supplementary state —
// a tab is "Buy Now\nTab 2 of 3", a field label is "Starting Price\n$".
// Match against that first line so our config strings stay the plain
// visible label. (parseAttrs already turned the dump's &#10; into "\n".)
function descFirstLine(node) {
  return (node['content-desc'] || '').split('\n')[0].trim().toLowerCase();
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

// Listing modes map to the three tabs at the top of Palmstreet's
// New-listing form. Each tab relabels the amount field, so we anchor the
// amount input to a per-mode label. These strings are the plain visible
// labels — Palmstreet actually exposes them as the first line of a
// multiline content-desc ("Buy Now\nTab 2 of 3", "Starting Price\n$"),
// which descFirstLine() handles. If Palmstreet renames a tab or field,
// update the strings here; they're matched case-insensitively.
const MODE_CONFIG = {
  auction:   { tab: 'Auction',  priceLabels: ['Starting Price'] },
  buy_now:   { tab: 'Buy Now',  priceLabels: ['Price'] },
  give_away: { tab: 'Giveaway', priceLabels: ['Giveaway Value'] },
};

// Format a dollar figure for typing: whole numbers get no decimals,
// everything else two places (so 25 → "25", 24.9 → "24.90").
function formatAmount(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Which dollar figure fills the amount field, per mode:
//   auction   → gross cost rounded UP (a floor to bid up from during the
//               live; avoids awkward $9.46-style starting prices)
//   buy_now   → the resolved listing price (the actual sale price)
//   give_away → the resolved listing price (the item's retail value)
// Returns null when the source figure is missing — the caller then leaves
// Palmstreet's own default in the field.
function amountForMode(mode, { price, grossCost }) {
  if (mode === 'auction') {
    // Guard null/'' explicitly: Number(null) and Number('') are both 0,
    // which would type a "0" floor instead of leaving Palmstreet's default.
    if (grossCost == null || grossCost === '') return null;
    const c = Number(grossCost);
    return Number.isFinite(c) ? String(Math.ceil(c)) : null;
  }
  if (price == null || price === '') return null;
  const p = Number(price);
  return Number.isFinite(p) && p > 0 ? formatAmount(p) : null;
}

// ── Listing surfaces: detection + navigation ────────────────────────────
// Palmstreet has TWO listing creators, and they hold different modes:
//   • "Quick listing" — the fast in-live overlay the sidebar "Listing"
//     button raises. Tabs: Auction / Buy Now only (NO Giveaway). Has a
//     "Pin & Run" button (create + pin to the live in one tap). This is
//     where auction/buy_now go.
//   • "New listing" — the full Shop form, reached via the sidebar "Shop"
//     button → manager sheet → Create (⊕). Tabs: Auction / Buy Now /
//     Giveaway. This is the only place Giveaway exists, so give_away
//     goes here.
// Both forms label tabs and fields the same way (multiline content-desc,
// "/60" title counter), so selectModeTab / findTitleField / findFieldByLabel
// work on either — only the entry path differs.

// The Quick-listing overlay: its header reads "Quick listing" and it
// carries the "Pin & Run" button.
function isQuickListing(xml) {
  return !!findNode(xml, a =>
    descFirstLine(a) === 'quick listing' || a['content-desc'] === 'Pin & Run');
}

// Only the full form has a node whose content-desc first line is "New listing".
function isNewListingForm(xml) {
  return !!findNode(xml, a => descFirstLine(a) === 'new listing');
}

// The manager sheet is identifiable by its bottom action bar, which
// Palmstreet exposes as a single View with content-desc
// "Manage\nImport\nCreate".
function isManagerSheet(xml) {
  return !!findNode(xml, a => {
    const cd = a['content-desc'] || '';
    return cd.includes('Manage') && cd.includes('Create');
  });
}

// True while the soft keyboard is shown — the IME contributes nodes under
// its own "...inputmethod..." package to the hierarchy dump. Used to wait
// for the keyboard to actually clear before tapping a field that sits in
// its footprint (e.g. the Quick-listing price row), instead of a blind
// sleep that's either too short (tap lands on a key) or wastefully long.
function keyboardUp(xml) {
  return /package="[^"]*inputmethod/i.test(xml);
}

// Poll dumpUI() until test(xml) holds (form rendered, sheet up, …).
// Returns the matching dump so the caller doesn't re-fetch it. A u2 dump
// is ~90ms, so a tight interval detects a transition quickly without
// hammering the device.
async function waitForXml(test, timeoutMs, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    if (test(xml)) return xml;
    await sleep(intervalMs);
  }
  return null;
}

// Device screen size, cached. Used to place taps for controls Palmstreet
// renders without an introspectable node (the manager sheet's bottom bar).
let _screen = null;
async function screenSize() {
  if (_screen) return _screen;
  let w = 1080, h = 2400;
  try {
    const out = await adbShell('wm', 'size');
    // Prefer an "Override size" (display scaling) over "Physical size".
    const m = out.match(/Override size:\s*(\d+)x(\d+)/)
           || out.match(/Physical size:\s*(\d+)x(\d+)/);
    if (m) { w = Number(m[1]); h = Number(m[2]); }
  } catch { /* fall back to the Pixel-8 default above */ }
  _screen = { w, h };
  return _screen;
}

// Locate the Create (⊕) button in the manager sheet's bottom bar. Manage
// / Import / Create render as un-labeled Buttons (empty text + desc), so
// we identify Create by position: the right-most clickable node sitting
// in the bottom strip of the screen.
function findCreateButton(xml, screenH) {
  const minY = screenH * 0.85;
  const btns = findAllNodes(xml, a => {
    if (a.clickable !== 'true') return false;
    const b = parseBounds(a.bounds);
    return b && b.cy > minY;
  });
  if (!btns.length) return null;
  return btns.reduce((best, a) =>
    parseBounds(a.bounds).cx > parseBounds(best.bounds).cx ? a : best);
}

// Return a tap target that focuses the "Listing Title" input. The two
// forms structure it differently:
//   • New listing — the whole title box is one wide View whose
//     content-desc starts "Listing Title" (or just shows the "/60"
//     counter). Tapping its center focuses the input.
//   • Quick listing — the title is a real EditText, and the "/60" counter
//     is a separate small badge in the top-right of the box. Tapping the
//     badge focuses nothing, so we must return the EditText itself.
// The "/60" counter is the stable anchor on both (vs the "/150"
// description counter); we branch on whether it spans the box or is a badge.
function findTitleField(xml) {
  // New-listing: a labeled, full-width title box — tap it directly.
  const box = findNode(xml, a => descFirstLine(a) === 'listing title');
  if (box) return box;
  // Otherwise anchor on the "/60" character counter.
  const counter = findNode(xml, a => (a['content-desc'] || '').includes('/60'));
  if (!counter) return null;
  const cb = parseBounds(counter.bounds);
  if (!cb) return null;
  // A wide counter node IS the title box (New listing, unlabeled variant).
  if (cb.x2 - cb.x1 > 400) return counter;
  // Quick listing: small badge → the input is the EditText sharing its
  // row (within ~120px vertically). Return that so the tap lands in it.
  const et = findAllNodes(xml, a => {
    if (!(a.class || '').endsWith('EditText')) return false;
    const b = parseBounds(a.bounds);
    return b && Math.abs(b.cy - cb.cy) <= 120;
  });
  return et[0] || counter;
}

// Locate an EditText by the label View sitting to its left. Tries each
// candidate label in turn (case-insensitive against the label's text /
// content-desc first line — Palmstreet labels read "Price\n$") and
// returns the same-row EditText. More robust than document-order
// position: focusing the title above scrolls the form, shifting every
// field below it and invalidating cached bounds.
function findFieldByLabel(xml, labels) {
  const SLOP = 30;
  for (const label of labels) {
    const want = label.trim().toLowerCase();
    const lbl = findNode(xml, a =>
      descFirstLine(a) === want ||
      (a.text || '').trim().toLowerCase() === want);
    if (!lbl) continue;
    const lb = parseBounds(lbl.bounds);
    if (!lb) continue;
    const candidates = findAllNodes(xml, a => {
      if (!(a.class || '').endsWith('EditText')) return false;
      const b = parseBounds(a.bounds);
      if (!b) return false;
      return b.cy >= lb.y1 - SLOP && b.cy <= lb.y2 + SLOP;
    });
    if (candidates[0]) return candidates[0];
  }
  return null;
}

// Select the Auction / Buy Now / Giveaway tab at the top of the open
// form. Palmstreet remembers the last-used tab, so this is often a no-op,
// but we assert it every scan so a "Buy Now" scan never lands on an
// Auction form left over from the previous one. The tab's content-desc is
// multiline ("Buy Now\nTab 2 of 3") so we match its first line. Prefer a
// clickable match so a stray occurrence of the word elsewhere on screen
// (a chat line, the video) can't be tapped instead of the tab.
//
// Tap-and-verify: the Quick-listing overlay slides in and both forms
// re-flow as the keyboard opens/closes, so a single tap on bounds read
// mid-animation lands nowhere and silently leaves the wrong tab active.
// Re-tap from a fresh dump until the tab is confirmed selected — by its
// selected="true" attribute OR by the mode's amount label appearing (the
// switch relabels the amount field). Either signal alone suffices, which
// covers both listing surfaces regardless of which attributes they expose.
// Accepts the form's dump (from openListingForm) to seed the first check
// without re-dumping, and returns the last dump it saw so the caller can
// locate the title field from it.
async function selectModeTab(cfg, seedXml) {
  const want = cfg.tab.trim().toLowerCase();
  const wantLabel = cfg.priceLabels[0].trim().toLowerCase();
  const pickTab = (xml) => {
    const all = findAllNodes(xml, a =>
      descFirstLine(a) === want ||
      (a.text || '').trim().toLowerCase() === want);
    return all.find(a => a.clickable === 'true') || all[0] || null;
  };
  const onTab = (xml, tab) =>
    (tab && tab.selected === 'true') ||
    !!findNode(xml, a => descFirstLine(a) === wantLabel);

  const deadline = Date.now() + 4000;
  let xml = seedXml || await dumpUI();
  let tab = pickTab(xml);
  while (!tab && Date.now() < deadline) {
    await sleep(200);
    xml = await dumpUI();
    tab = pickTab(xml);
  }
  if (!tab) {
    throw new Error(`listing mode tab "${cfg.tab}" not found — open Palmstreet's listing form, or update MODE_CONFIG if the tab was renamed`);
  }
  while (Date.now() < deadline) {
    if (onTab(xml, tab)) return xml;
    await tapBoundsAttr(tab.bounds);
    await sleep(180);  // brief settle; the re-dump below confirms or re-taps
    xml = await dumpUI();
    tab = pickTab(xml);
    if (!tab) break;
  }
  if (tab && onTab(xml, tab)) return xml;
  throw new Error(`listing mode tab "${cfg.tab}" did not become selected`);
}

// Palmstreet listing automation — mode-aware (Auction / Buy Now /
// Giveaway).
//
// During a live, scanning a SKU opens the right listing creator for the
// chosen mode, selects the mode tab, and pre-fills the title + amount.
// The operator still sets quantity/image and taps the final button
// ("Pin & Run" on Quick listing, "Pin" on the full form) themselves —
// that split keeps a human in the loop for the final post.
//
// Steps:
//   1. open the listing form for this mode — Quick listing (sidebar
//      "Listing") for auction/buy_now, the full New-listing form (sidebar
//      "Shop" → Create ⊕) for give_away, which is the only surface with a
//      Giveaway tab
//   2. select the mode tab (Auction / Buy Now / Giveaway)
//   3. type the title into the "Listing Title" field
//   4. anchor to the mode's amount label and type the amount
export async function listing({ sku, name, grossCost, price, mode }) {
  if (typeof name !== 'string' || !name) throw new Error('name required');
  // Unknown / missing mode falls back to auction — that's the original
  // single-mode behavior, so an older web build that doesn't send `mode`
  // keeps working unchanged.
  const modeKey = MODE_CONFIG[mode] ? mode : 'auction';
  const cfg = MODE_CONFIG[modeKey];

  // Title format on Palmstreet: "SKU - NAME". Operator scans during a
  // live to look up the inventory item later by SKU; the plant name
  // alone isn't unique. Bare name when sku is missing (shouldn't
  // happen in the Live Scan flow, but be defensive).
  const title = sku ? `${sku} - ${name}` : name;

  // Amount string for this mode (see amountForMode): auction uses the
  // gross-cost floor, buy_now/give_away use the resolved listing price.
  // Null when the source figure is missing — we leave Palmstreet's default.
  const amount = amountForMode(modeKey, { price, grossCost });

  // ── 1. Open the listing form for this mode ────────────────────────
  // openListingForm returns the form's dump; we thread it through the tab
  // select and title lookup so each step reuses it instead of re-dumping.
  let xml = await openListingForm(modeKey);

  // ── 2. Select the mode tab ────────────────────────────────────────
  // If the tab can't be found: for auction (the default + legacy path
  // that worked before tabs existed) warn and proceed on whatever tab is
  // active — never worse than the old behavior. For buy_now/give_away,
  // proceeding would post the wrong listing type at the wrong price, so
  // fail loudly instead.
  try {
    xml = await selectModeTab(cfg, xml);
  } catch (e) {
    if (modeKey !== 'auction') throw e;
    console.warn(`[${new Date().toISOString()}] ${e.message} — proceeding on the current tab (auction default)`);
    xml = await dumpUI();
  }
 

  // ── 3. Type the title ─────────────────────────────────────────────
  // The title field is a plain View until focused, at which point it
  // becomes an EditText. Locate it by its "/60" counter — the same widget
  // on both Quick listing and the full New-listing form. Reuse the dump
  // selectModeTab left us; only re-poll if the field isn't there yet (the
  // tab switch can briefly re-flow the form).
  let formXml = xml;
  let titleField = findTitleField(formXml);
  if (!titleField) {
    formXml = await waitForXml(x => !!findTitleField(x), 4000);
    titleField = formXml && findTitleField(formXml);
  }
  if (!titleField) {
    await checkPalmstreetForeground();
    throw new Error('listing form title field not found after selecting the mode tab');
  }
  // Does the title already hold text (a reused, un-pinned previous form)?
  // The "/60" counter reads "0/60" when empty and "<n>/60" otherwise. Only
  // clear when non-empty — a fresh scan skips the 64-keystroke MOVE_END +
  // backspaces entirely (the common live case).
  const titleHasText = !!findNode(formXml, a =>
    (a['content-desc'] || '').split('\n').some(l => /^[1-9]\d*\/60$/.test(l.trim())));
  await tapBoundsAttr(titleField.bounds);
  await sleep(160);  // field gains focus (input text targets it regardless of kb anim)
  if (titleHasText) {
    // MOVE_END + a generous run of backspaces; 60 is the title's max length.
    await adbShell('input', 'keyevent', '123', ...Array(64).fill('67'));
  }
  await typeText(title);
  // Dismiss the soft keyboard. KEYCODE_BACK only hides the keyboard here —
  // it doesn't close the form. The amount step waits for it to clear.
  await adbShell('input', 'keyevent', '4');

  // ── 4. Pre-fill the amount ────────────────────────────────────────
  let prefilled = ['title'];
  if (amount) {
    // Wait for the title's keyboard to actually clear before locating and
    // tapping the amount field: on Quick listing the price row sits inside
    // the keyboard's footprint, so tapping while it's still up lands on a
    // key. This poll returns the instant the keyboard is gone (usually
    // well under the old fixed 400ms) and never taps too early. Reuse its
    // dump for the first field lookup.
    let kbXml = await waitForXml(x => !keyboardUp(x), 1500);
    // Find the amount EditText by anchoring to the mode's price label
    // ("Price" / "Starting Price" / "Giveaway Value"). Re-dump rather
    // than reuse pre-title bounds: focusing/typing the title scrolls the
    // form, so every field below it moved. Retry briefly — a tab switch
    // or keyboard dismiss can leave a transient frame where the label is
    // absent from the dump.
    let amountTarget = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = findFieldByLabel(kbXml || await dumpUI(), cfg.priceLabels);
      if (found) { amountTarget = found.bounds; break; }
      kbXml = null;  // first pass reused the keyboard-clear dump; re-dump after
      await sleep(120);
    }
    if (amountTarget) {
      await tapBoundsAttr(amountTarget);
      await sleep(160);  // keyboard slides up for the amount field
      // MOVE_END + backspaces clears the field's default (usually "1").
      // `input keyevent` takes a variadic keycode list, so one round-trip
      // clears the field; overshooting a short default is a no-op.
      await adbShell('input', 'keyevent', '123', '67', '67', '67', '67', '67', '67', '67', '67', '67', '67');
      await typeText(amount);
      await adbShell('input', 'keyevent', '4');  // dismiss keyboard again
      prefilled.push('amount');
    } else {
      // Don't guess a field here: on this form a wrong guess would land
      // the price in the Quantity box. Leave the default and warn.
      console.warn(`[${new Date().toISOString()}] couldn't locate the "${cfg.priceLabels[0]}" field — leaving the amount at its default`);
    }
  }

  return { sku, name, title, mode: modeKey, amount, prefilled };
}

// Open the correct listing creator for the mode. give_away only exists in
// the full Shop form (Quick listing has no Giveaway tab), so it routes
// through openNewListingForm; auction/buy_now use the fast Quick-listing
// overlay.
function openListingForm(modeKey) {
  return modeKey === 'give_away' ? openNewListingForm() : openQuickListing();
}

// Raise the "Quick listing" overlay (sidebar "Listing"). Already up from
// an un-pinned previous scan → done. Otherwise wake the auto-hidden
// sidebar and tap "Listing". Retries once; foreground check on failure so
// a backgrounded app gives a clear message, not a node-not-found error.
// Returns the dump of the open overlay so the caller can reuse it (tab
// select, title lookup) instead of re-dumping.
async function openQuickListing() {
  const x0 = await dumpUI();
  if (isQuickListing(x0)) return x0;

  async function attempt(timeoutMs) {
    await adbShell('input', 'tap', '540', '700');  // wake hidden sidebar
    await tap({ contentDesc: 'Listing', timeoutMs: 8000 });
    const x = await waitForXml(isQuickListing, timeoutMs);
    if (!x) return null;
    // The overlay is present but still sliding in — its node bounds are
    // mid-animation. Let it settle and re-dump so the caller's first tab
    // tap lands on final bounds instead of retrying through the slide.
    await sleep(250);
    return await dumpUI();
  }

  try {
    let x = await attempt(5000);
    if (x) return x;
    console.warn(`[${new Date().toISOString()}] Quick-listing overlay didn't open — retrying once`);
    x = await attempt(4000);
    if (x) return x;
  } catch (e) {
    await checkPalmstreetForeground();
    throw e;
  }
  await checkPalmstreetForeground();
  throw new Error('Quick-listing overlay did not open — make sure Palmstreet is foregrounded and the live sidebar "Listing" button is reachable');
}

// Navigate Palmstreet to its full "New listing" form (the only surface
// with a Giveaway tab) from wherever the app currently sits:
//   • already on the form (an un-pinned previous scan) → done
//   • on the manager sheet → tap Create (⊕)
//   • elsewhere (a live with the sidebar hidden) → wake the sidebar, tap
//     "Shop" to raise the manager sheet, then Create
// Retries once, and runs a foreground check on failure so a backgrounded
// Palmstreet surfaces a clear message instead of a node-not-found error.
// Returns the dump of the open New-listing form so the caller can reuse it.
async function openNewListingForm() {
  const xml0 = await dumpUI();
  if (isNewListingForm(xml0)) return xml0;

  // Tap Create (⊕) on a manager sheet, then wait for the form. Returns the
  // form's dump, or null on timeout.
  async function tapCreate(sheetXml, timeoutMs) {
    const { w, h } = await screenSize();
    const create = findCreateButton(sheetXml, h);
    if (create) {
      await tapBoundsAttr(create.bounds);
    } else {
      // No node matched — fall back to a proportional tap on the bar's
      // right-most slot (Create sits at ~91% width, ~90% height).
      await adbShell('input', 'tap',
        String(Math.round(w * 0.909)), String(Math.round(h * 0.904)));
    }
    const x = await waitForXml(isNewListingForm, timeoutMs);
    if (!x) return null;
    await sleep(250);  // let the form settle so tab bounds are final
    return await dumpUI();
  }

  // Already on the manager sheet (operator opened it, or a previous scan
  // left it up)? Skip the sidebar dance and go straight to Create —
  // wake-tapping (540,700) would otherwise tap a listing row in the sheet.
  if (isManagerSheet(xml0)) {
    const x = await tapCreate(xml0, 5000);
    if (x) return x;
  }

  async function attempt(timeoutMs) {
    // Wake the auto-hidden sidebar (no-op outside a live / when already
    // visible), then tap "Shop" to raise the manager sheet. Wide timeout
    // rides through Palmstreet's post-sale "SOLD" animation, which can
    // hide the sidebar for several seconds.
    await adbShell('input', 'tap', '540', '700');
    await tap({ contentDesc: 'Shop', timeoutMs: 8000 });
    const surface = await waitForXml(
      xml => isNewListingForm(xml) || isManagerSheet(xml), timeoutMs);
    if (!surface) return null;
    if (isNewListingForm(surface)) return surface;  // jumped straight to the form
    return tapCreate(surface, timeoutMs);
  }

  try {
    let x = await attempt(5000);
    if (x) return x;
    console.warn(`[${new Date().toISOString()}] New-listing form didn't open — retrying once`);
    x = await attempt(4000);
    if (x) return x;
  } catch (e) {
    await checkPalmstreetForeground();
    throw e;
  }
  await checkPalmstreetForeground();
  throw new Error('New-listing form did not open — make sure Palmstreet is foregrounded and the sidebar "Shop" → Create flow is reachable');
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
      console.warn('  ⚠ no ADB devices detected — plug in the phone via USB');
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

// Start polling only when run directly (node index.js / start.sh). When
// the module is imported (e.g. a test harness exercising listing()), skip
// the poller so the importer drives individual actions itself.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
