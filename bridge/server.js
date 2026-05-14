// Folia ADB bridge — exposes a small HTTP API that shells out to `adb` on
// the host Mac. The Folia web app posts to it from a browser on the same
// LAN to drive an Android phone running Palmstreet.
//
// Phase 1 deliverable: transport + helpers + listing-queue stub. The
// Palmstreet-specific scripted sequence lands in Phase 2.

import express from 'express';
import cors from 'cors';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const exec = promisify(execFile);

const PORT = parseInt(process.env.BRIDGE_PORT || '7755', 10);
const SECRET = process.env.BRIDGE_SECRET || '';
// If multiple devices are connected, set BRIDGE_DEVICE to the serial from
// `adb devices` so commands target the right phone.
const DEVICE = process.env.BRIDGE_DEVICE || '';

if (!SECRET) {
  console.warn('⚠ BRIDGE_SECRET not set — anyone on your LAN can drive your phone.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Shared-secret auth. Health check is intentionally exempt so a quick
// browser ping can confirm the bridge is up without needing the token.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!SECRET) return next();
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ─── adb wrappers ───────────────────────────────────────────────────────────

async function adb(...args) {
  const fullArgs = DEVICE ? ['-s', DEVICE, ...args] : args;
  try {
    const { stdout } = await exec('adb', fullArgs, { encoding: 'utf8', maxBuffer: 4 << 20 });
    return stdout;
  } catch (e) {
    const err = new Error(`adb ${fullArgs.join(' ')} failed: ${(e.stderr || e.message || '').trim()}`);
    err.cause = e;
    throw err;
  }
}

const adbShell = (...args) => adb('shell', ...args);

async function listDevices() {
  const out = await adb('devices');
  return out.split('\n').slice(1)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [serial, status] = l.split(/\s+/);
      return { serial, status };
    });
}

// ─── UI tree dump + node finding ────────────────────────────────────────────

// `uiautomator dump` writes to a file on the device; `exec-out cat` is the
// binary-safe way to pull that file back without newline mangling.
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

// uiautomator's XML is single-line per node with all attributes inline,
// so a regex sweep is reliable enough without pulling in an XML parser.
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

// Poll the UI tree until `predicate` matches a node or we time out.
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

// ─── Endpoints ──────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    const devices = await listDevices();
    res.json({ ok: true, adbDevices: devices, target: DEVICE || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Tap by pixel, by resource-id, or by visible text. resource-id is the
// most resilient across Palmstreet updates; pixel taps are the fallback.
app.post('/tap', async (req, res) => {
  const { x, y, resourceId, text, timeoutMs } = req.body || {};
  try {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      await adbShell('input', 'tap', String(x), String(y));
      return res.json({ ok: true, tapped: { x, y } });
    }
    if (resourceId || text) {
      const node = await waitForNode(
        attrs => (resourceId && attrs['resource-id'] === resourceId) ||
                 (text && attrs.text === text),
        { timeoutMs: timeoutMs ?? 3000 }
      );
      if (!node) return res.status(404).json({ error: 'node not found within timeout' });
      const b = parseBounds(node.bounds);
      if (!b) return res.status(500).json({ error: 'no bounds on matched node' });
      await adbShell('input', 'tap', String(b.cx), String(b.cy));
      return res.json({ ok: true, tapped: b, matched: { 'resource-id': node['resource-id'], text: node.text } });
    }
    res.status(400).json({ error: 'provide x+y, resourceId, or text' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// `adb shell input text` is whitespace-sensitive: literal spaces become
// %s. Quotes / shell metachars are escaped to keep the shell happy.
app.post('/type', async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '%s')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
  try {
    await adbShell('input', 'text', escaped);
    res.json({ ok: true, length: text.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/dump', async (req, res) => {
  try {
    const xml = await dumpUI();
    res.type('text/xml').send(xml);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Phase 1 stub: accept a listing, push it onto an in-memory queue, and
// return immediately. Phase 2 replaces the body with the scripted
// Palmstreet "add listing during live" sequence.
const queue = [];
app.post('/listing', async (req, res) => {
  const { name, price, sku } = req.body || {};
  if (!name || !Number.isFinite(parseFloat(price))) {
    return res.status(400).json({ error: 'name and numeric price required' });
  }
  const entry = {
    id: Date.now().toString(36),
    sku: sku || null,
    name,
    price: parseFloat(price),
    queuedAt: new Date().toISOString(),
    status: 'queued',
  };
  queue.push(entry);
  console.log(`[listing] queued ${entry.sku || ''} "${entry.name}" @ $${entry.price.toFixed(2)} (${queue.length} total)`);
  res.json({ ok: true, accepted: entry, pending: queue.filter(q => q.status === 'queued').length });
});

app.get('/queue', (req, res) => res.json({ queue }));

// ─── Boot ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal);
  console.log(`Folia bridge listening on :${PORT}`);
  console.log(`  http://localhost:${PORT}/health`);
  for (const i of lan) console.log(`  http://${i.address}:${PORT}/health`);
  if (!SECRET) console.log('  (no auth — set BRIDGE_SECRET to lock down)');
});
