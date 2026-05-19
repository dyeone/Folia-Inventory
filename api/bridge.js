import { supabase, requireUser, requireAdmin, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { randomBytes } from 'node:crypto';

// Routes the local Folia Bridge talks to. The bridge polls outbound from
// the operator's Mac because it can't accept inbound from Vercel (mixed
// content + NAT). Three actions:
//
//   POST  ?action=enqueue          web → enqueue a job  (user auth)
//   POST  ?action=generate-token   web → mint bridge token (user auth)
//   GET   ?action=next             bridge → claim oldest pending (bridge auth)
//   POST  ?action=complete         bridge → report done/failed   (bridge auth)
//
// Bridge auth = Authorization: Bearer <users.bridgeToken>. User auth =
// userId in query (GET) or body (POST), matching the rest of the API.

// How long a 'running' job can sit before /next is allowed to re-claim
// it. Covers a bridge crash mid-job. Tune up if real ADB sequences
// routinely take longer than this.
const STALE_RUNNING_MS = 60_000;

async function requireBridgeUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const e = new Error('Bridge token required'); e.status = 401; throw e;
  }
  const { data, error } = await supabase
    .from('users')
    .select('id, role, active, "displayName"')
    .eq('bridgeToken', token)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!data || !data.active) {
    const e = new Error('Invalid bridge token'); e.status = 401; throw e;
  }
  return data;
}

export default wrap(async (req, res) => {
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;
  if (!action) { const e = new Error('action required'); e.status = 400; throw e; }

  switch (action) {
    case 'generate-token':  return generateToken(req, res);
    case 'enqueue':         return enqueue(req, res);
    case 'next':            return next(req, res);
    case 'complete':        return complete(req, res);
    case 'status':          return status(req, res);
    case 'health':          return health(req, res);
    case 'phone-heartbeat': return phoneHeartbeat(req, res);
    case 'phone-target':    return phoneTarget(req, res);
    default: {
      const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
    }
  }
});

// Android Bridge Helper → POST {deviceIp, debugPort}. Authenticated
// with the user's bridge token (same one used by the Mac bridge poller)
// so a third party can't spoof a phone target. The helper does mDNS
// discovery on the phone itself for the live _adb-tls-connect._tcp
// port and reports it here every ~10s while wireless debug is on.
async function phoneHeartbeat(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireBridgeUser(req);
  const { deviceIp, debugPort } = req.body || {};
  const ip = String(deviceIp || '').trim();
  const port = parseInt(debugPort, 10);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const e = new Error('deviceIp must be a dotted IPv4'); e.status = 400; throw e;
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    const e = new Error('debugPort must be 1..65535'); e.status = 400; throw e;
  }
  const { error } = await supabase
    .from('users')
    .update({
      phoneIp: ip,
      phonePort: port,
      phoneLastSeen: new Date().toISOString(),
    })
    .eq('id', user.id);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true });
}

// Mac bridge → GET the latest known phone target. Bridge auth (same
// Bearer token the helper uses; this assumes one user owns both ends
// of the bridge, which is true in the current single-tenant setup).
// Returns the most recently heartbeated target across active users —
// in practice always the single user that's running both helper +
// bridge. Includes lastSeen so the Mac side can decide whether the
// target is fresh enough to trust.
async function phoneTarget(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  await requireBridgeUser(req);
  const { data, error } = await supabase
    .from('users')
    .select('"phoneIp","phonePort","phoneLastSeen"')
    .not('phoneLastSeen', 'is', null)
    .order('phoneLastSeen', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!data || !data.phoneIp || !data.phonePort) {
    return res.status(200).json({ target: null });
  }
  return res.status(200).json({
    target: {
      ip: data.phoneIp,
      port: data.phonePort,
      lastSeen: data.phoneLastSeen,
    },
  });
}

// Mint (or rotate) a bridge token for the calling user. Returns the
// plaintext token once — there's no way to recover it later, since we
// don't store anything alongside it that would let us re-derive it.
//
// Admin-only: a bridge token grants ADB-level control over the
// operator's phone, which can drive Palmstreet on behalf of the user.
// Staff and packer roles should never be able to mint one.
async function generateToken(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireAdmin(req.body?.userId);
  const token = randomBytes(32).toString('hex');
  const { error } = await supabase
    .from('users')
    .update({ bridgeToken: token })
    .eq('id', user.id);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ token });
}

async function enqueue(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req.body?.userId);
  const { jobAction, payload } = req.body || {};
  if (!jobAction || typeof jobAction !== 'string') {
    const e = new Error('jobAction required'); e.status = 400; throw e;
  }
  const job = {
    id: newId(),
    status: 'queued',
    action: jobAction,
    payload: payload && typeof payload === 'object' ? payload : {},
    createdBy: user.displayName || user.id,
  };
  const { error } = await supabase.from('bridge_jobs').insert(job);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ job });
}

// Try once to claim the oldest queued (or stale-running) job. Atomic via
// CAS: select candidate, then guarded UPDATE on its prior status. If 0
// rows return, another bridge raced us; treat as "nothing claimed".
async function tryClaim(user) {
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const { data: candidate, error: selErr } = await supabase
    .from('bridge_jobs')
    .select('*')
    .or(`status.eq.queued,and(status.eq.running,claimedAt.lt.${staleCutoff})`)
    .order('createdAt', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (selErr) { const e = new Error(selErr.message); e.status = 500; throw e; }
  if (!candidate) return null;

  const { data: claimed, error: updErr } = await supabase
    .from('bridge_jobs')
    .update({
      status: 'running',
      claimedAt: new Date().toISOString(),
      claimedBy: user.displayName || user.id,
    })
    .eq('id', candidate.id)
    .eq('status', candidate.status)  // CAS guard against races
    .select()
    .maybeSingle();
  if (updErr) { const e = new Error(updErr.message); e.status = 500; throw e; }
  return claimed || null;
}

// Long-poll for the next job. The bridge used to short-poll every 500 ms
// — that meant ~250 ms of dead time on every scan between the operator
// tapping the SKU and the bridge issuing its first ADB call. Holding the
// request open server-side until a job lands collapses that gap to just
// the network RTT (~80–150 ms).
//
// Vercel Hobby caps function duration at 10 s, so we deadline ~9 s and
// fall back to a null response, which the bridge treats like a normal
// idle tick and immediately re-polls.
const NEXT_LONG_POLL_MS = 9_000;
const NEXT_POLL_INTERVAL_MS = 200;

async function next(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireBridgeUser(req);

  // Heartbeat. /health reads this to decide if the bridge is online.
  // With long-poll, the bridge issues at most one request per ~9 s when
  // idle, so HEARTBEAT_FRESH_MS has to be wider than the long-poll
  // deadline — see the constant for the calculation.
  await supabase
    .from('users')
    .update({ bridgeLastSeen: new Date().toISOString() })
    .eq('id', user.id);

  const deadline = Date.now() + NEXT_LONG_POLL_MS;
  while (true) {
    const claimed = await tryClaim(user);
    if (claimed) return res.status(200).json({ job: claimed });
    if (Date.now() >= deadline) return res.status(200).json({ job: null });
    await new Promise(r => setTimeout(r, NEXT_POLL_INTERVAL_MS));
  }
}

// Bulk status lookup for the UI's polling loop. ?ids=a,b,c — at most 32
// at a time so the URL stays short and the SELECT is bounded.
async function status(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  await requireUser(req.query?.userId);
  const raw = (req.query?.ids || '').toString();
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 32);
  if (ids.length === 0) return res.status(200).json({ jobs: [] });
  const { data, error } = await supabase
    .from('bridge_jobs')
    .select('id, status, action, payload, result, error, "createdAt", "claimedAt", "completedAt"')
    .in('id', ids);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ jobs: data || [] });
}

// Liveness signal for the UI's "bridge online" indicator. Reads the
// explicit heartbeat that /next writes at the start of every long-poll
// cycle. With long-poll on, the bridge writes a heartbeat at most every
// NEXT_LONG_POLL_MS (9 s) when idle, so the freshness window has to be
// wider than the long-poll deadline plus one full poll round-trip.
// 15 s = 9 s deadline + ~1 s RTT + ~5 s grace.
const HEARTBEAT_FRESH_MS = 15_000;

async function health(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  await requireUser(req.query?.userId);
  const [{ data: heartbeatRow }, { count: queuedCount }] = await Promise.all([
    supabase.from('users')
      .select('bridgeLastSeen')
      .not('bridgeLastSeen', 'is', null)
      .order('bridgeLastSeen', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('bridge_jobs')
      .select('id', { count: 'exact', head: true }).eq('status', 'queued'),
  ]);
  const lastSeen = heartbeatRow?.bridgeLastSeen || null;
  const online = !!lastSeen && (Date.now() - new Date(lastSeen).getTime()) < HEARTBEAT_FRESH_MS;
  return res.status(200).json({
    online,
    lastSeen,
    queued: queuedCount || 0,
  });
}

async function complete(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  await requireBridgeUser(req);
  const { id, result, error: errMsg } = req.body || {};
  if (!id) { const e = new Error('job id required'); e.status = 400; throw e; }
  const status = errMsg ? 'failed' : 'done';
  const { data, error } = await supabase
    .from('bridge_jobs')
    .update({
      status,
      result: result ?? null,
      error: errMsg || null,
      completedAt: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!data) { const e = new Error('Job not found'); e.status = 404; throw e; }
  return res.status(200).json({ job: data });
}
