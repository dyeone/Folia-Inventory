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
//   POLL_MS          poll interval in ms (default 1500)

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
const POLL_MS = parseInt(process.env.POLL_MS || '1500', 10);

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

async function dumpUI() {
  await adbShell('uiautomator', 'dump', '/sdcard/ui.xml');
  return adb('exec-out', 'cat', '/sdcard/ui.xml');
}

function parseBounds(boundsAttr) {
  const m = (boundsAttr || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const [, x1, y1, x2, y2] = m.map(Number);
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

function findNode(xml, predicate) {
  const matches = xml.match(/<node\s[^>]*>/g) || [];
  for (const tag of matches) {
    const attrs = Object.fromEntries(
      [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]])
    );
    if (predicate(attrs)) return attrs;
  }
  return null;
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

async function tap({ x, y, resourceId, text, timeoutMs }) {
  if (Number.isFinite(x) && Number.isFinite(y)) {
    await adbShell('input', 'tap', String(x), String(y));
    return { tapped: { x, y } };
  }
  if (resourceId || text) {
    const node = await waitForNode(
      a => (resourceId && a['resource-id'] === resourceId) || (text && a.text === text),
      { timeoutMs: timeoutMs ?? 3000 }
    );
    if (!node) throw new Error(`node not found: ${resourceId || text}`);
    const b = parseBounds(node.bounds);
    if (!b) throw new Error('matched node has no bounds');
    await adbShell('input', 'tap', String(b.cx), String(b.cy));
    return { tapped: b };
  }
  throw new Error('tap needs x+y, resourceId, or text');
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
      // Phase 2 stub — the Palmstreet "add listing during live" script
      // lands here once we've captured the resource-ids.
      return {
        stub: true,
        wouldListing: job.payload,
        note: 'Phase 2: scripted Palmstreet sequence not implemented yet',
      };
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
