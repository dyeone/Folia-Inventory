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

// Listing modes map to the three tabs at the top of Palmstreet's
// add-listing form. Each tab relabels the amount field, so we anchor the
// amount input to a per-mode label. If Palmstreet renames a tab or a
// field, update the strings here — they're matched case-insensitively
// against each node's text / content-desc.
const MODE_CONFIG = {
  auction:   { tab: 'Auction',  priceLabels: ['Starting Price'] },
  buy_now:   { tab: 'Buy Now',  priceLabels: ['Price'] },
  give_away: { tab: 'Giveaway', priceLabels: ['Giveaway value'] },
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

// The form's two visible inputs (title + amount). y2 < 1700 filters out
// the host view's chat-input EditText that sits below the listing sheet.
function formEditTexts(xml) {
  return findAllNodes(xml, a => {
    if (!(a.class || '').endsWith('EditText')) return false;
    const b = parseBounds(a.bounds);
    return b && b.y2 < 1700;
  });
}

// Poll dumpUI() until the Quick-listing form exposes its inputs. The
// initial open requires the "Pin & Run" button as a render signal to
// avoid a mid-animation false positive; after a tab switch the form is
// already up, so requirePinRun=false just waits for the two EditTexts to
// settle (a mode tab might not carry the same Pin & Run label).
async function grabFormFields(timeoutMs, requirePinRun = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    const ready = requirePinRun
      ? !!findNode(xml, a => a['content-desc'] === 'Pin & Run')
      : true;
    if (ready) {
      const fields = formEditTexts(xml);
      if (fields.length >= 2) return fields;
    }
    await sleep(200);
  }
  return null;
}

// Locate an EditText by the label View sitting to its left. Tries each
// candidate label in turn (case-insensitive against text / content-desc)
// and returns the same-row EditText. More robust than document-order
// position: a long title can wrap to a second line and shift every field
// below it down, invalidating cached bounds.
function findFieldByLabel(xml, labels) {
  const SLOP = 30;
  for (const label of labels) {
    const want = label.trim().toLowerCase();
    const lbl = findNode(xml, a =>
      (a['content-desc'] || '').trim().toLowerCase() === want ||
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
// Auction form left over from the previous one. Prefer a clickable match
// so a stray occurrence of the word elsewhere on screen (a chat line, the
// video) can't be tapped instead of the tab.
async function selectModeTab(tabLabel) {
  const want = tabLabel.trim().toLowerCase();
  const pick = (xml) => {
    const all = findAllNodes(xml, a =>
      (a.text || '').trim().toLowerCase() === want ||
      (a['content-desc'] || '').trim().toLowerCase() === want);
    return all.find(a => a.clickable === 'true') || all[0] || null;
  };
  let node = pick(await dumpUI());
  const deadline = Date.now() + 2500;
  while (!node && Date.now() < deadline) {
    await sleep(200);
    node = pick(await dumpUI());
  }
  if (!node) {
    throw new Error(`listing mode tab "${tabLabel}" not found — open Palmstreet's add-listing form, or update MODE_CONFIG if the tab was renamed`);
  }
  await tapBoundsAttr(node.bounds);
  await sleep(400);  // let the form re-render for the selected mode
}

// Palmstreet "Quick listing" automation — mode-aware (Auction / Buy Now /
// Giveaway).
//
// During a live, scanning a SKU opens the Quick-listing form, selects the
// operator's chosen mode tab, and pre-fills the title + amount. The
// operator still sets quantity/image and taps "Pin & Run" themselves —
// that split keeps a human in the loop for the final post.
//
// Steps:
//   1. tap sidebar "Listing" (open the form)
//   2. wait for the form to render (Pin & Run + 2 EditTexts)
//   3. select the mode tab (Auction / Buy Now / Giveaway)
//   4. re-grab fields — the tab switch relabels the amount field
//   5. type the title into the first EditText
//   6. anchor to the mode's amount label and type the amount
async function listing({ sku, name, grossCost, price, mode }) {
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
  // Null when the source figure is missing — we leave the default.
  const amount = amountForMode(modeKey, { price, grossCost });

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
    return grabFormFields(formDeadlineMs);
  }

  // Pre-check: is the form already open from a previous scan that the
  // operator hasn't pinned yet? If so, the sidebar is hidden behind it,
  // so tapping "Listing" would fail with "node not found" — but we don't
  // need to tap Listing at all. Just grab the existing EditTexts and
  // type the new values over the old. Skips one dump+two taps on the
  // happy path of back-to-back scans.
  function grabFieldsIfOpen(xml) {
    if (!findNode(xml, a => a['content-desc'] === 'Pin & Run')) return null;
    const fields = formEditTexts(xml);
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
  await openOrDiagnose();

  // Select the mode tab, then re-grab the inputs from a fresh dump.
  // Switching tabs relabels the amount field and can re-render the
  // EditTexts, so any bounds captured before the switch are stale.
  //
  // If the tab can't be found: for auction (the default + legacy path
  // that worked before tabs existed) warn and proceed on whatever tab is
  // active — never worse than the old behavior. For buy_now/give_away,
  // proceeding would post the wrong listing type at the wrong price, so
  // fail loudly instead.
  try {
    await selectModeTab(cfg.tab);
  } catch (e) {
    if (modeKey !== 'auction') throw e;
    console.warn(`[${new Date().toISOString()}] ${e.message} — proceeding on the current tab (auction default)`);
  }
  const editTexts = await grabFormFields(4000, false);
  if (!editTexts) {
    await checkPalmstreetForeground();
    throw new Error(`listing form fields not found after selecting the "${cfg.tab}" tab`);
  }

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

  // Pre-fill the amount field for this mode. Defaults in the form are
  // small placeholders; clear before typing.
  //
  // The title field has a 0/60 counter and grows downward when a long
  // title wraps to a second line, shifting the amount field below the
  // bounds we captured at form-open. So we re-dump after dismissing the
  // keyboard and anchor to the mode's amount label (always a View on the
  // left of the input) rather than relying on cached bounds.
  let prefilled = ['title'];
  if (amount) {
    // Try to find the label-anchored amount field. Retry for up to ~5 s —
    // back-to-back scans can leave the form in a transient re-render
    // state where the label is briefly absent from the dump.
    let amountTarget = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(120);
      const found = findFieldByLabel(await dumpUI(), cfg.priceLabels);
      if (found) { amountTarget = found.bounds; break; }
    }
    // Fallback: if the label still isn't in the dump, re-dump and take
    // the second EditText (y2<1700) from the FRESH tree. We can't use the
    // editTexts captured above: if the title wrapped to two lines after
    // we typed it, every field below shifted down, and the cached bounds
    // for editTexts[1] now point at the title's second line — typing the
    // amount there would land in the title field. A fresh dump's
    // editTexts[1] has the current bounds.
    if (!amountTarget) {
      const fresh = formEditTexts(await dumpUI());
      if (fresh.length >= 2) {
        console.warn(`[${new Date().toISOString()}] "${cfg.priceLabels[0]}" label not found — using fresh editTexts[1]`);
        amountTarget = fresh[1].bounds;
      }
    }
    if (amountTarget) {
      await tapBoundsAttr(amountTarget);
      await sleep(220);  // keyboard slides up for the amount field
      // MOVE_END + 8 backspaces in a single adb call. `input keyevent`
      // accepts a variadic keycode list, so one round-trip clears the
      // field instead of nine. Overshooting on a 1- or 2-digit default
      // is a no-op, so 8 is safe regardless of the default's length.
      await adbShell('input', 'keyevent', '123', '67', '67', '67', '67', '67', '67', '67', '67');
      await typeText(amount);
      await adbShell('input', 'keyevent', '4');  // dismiss keyboard again
      prefilled.push('amount');
    } else {
      console.warn(`[${new Date().toISOString()}] couldn't locate "${cfg.priceLabels[0]}" field after title — leaving default`);
    }
  }

  return { sku, name, title, mode: modeKey, amount, prefilled };
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

main();
