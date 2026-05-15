import { supabase, requireUser, newId } from './_lib/supabase.js';
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
    case 'generate-token': return generateToken(req, res);
    case 'enqueue':        return enqueue(req, res);
    case 'next':           return next(req, res);
    case 'complete':       return complete(req, res);
    case 'status':         return status(req, res);
    case 'health':         return health(req, res);
    default: {
      const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
    }
  }
});

// Mint (or rotate) a bridge token for the calling user. Returns the
// plaintext token once — there's no way to recover it later, since we
// don't store anything alongside it that would let us re-derive it.
async function generateToken(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req.body?.userId);
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

// Atomic claim: find the oldest queued (or stale-running) job, try to
// transition it to 'running' with a guard on the prior status. If the
// guarded update returns 0 rows, another bridge raced us; just return
// empty and let the caller poll again.
async function next(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireBridgeUser(req);

  // Heartbeat. /health reads this to decide if the bridge is online —
  // every /next poll (~1.5 s) keeps the timestamp fresh, regardless of
  // whether a job is actually claimed.
  await supabase
    .from('users')
    .update({ bridgeLastSeen: new Date().toISOString() })
    .eq('id', user.id);

  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();

  // Prefer queued; fall back to a running job that's gone stale.
  const { data: candidate, error: selErr } = await supabase
    .from('bridge_jobs')
    .select('*')
    .or(`status.eq.queued,and(status.eq.running,claimedAt.lt.${staleCutoff})`)
    .order('createdAt', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (selErr) { const e = new Error(selErr.message); e.status = 500; throw e; }
  if (!candidate) return res.status(200).json({ job: null });

  const claimedAt = new Date().toISOString();
  const { data: claimed, error: updErr } = await supabase
    .from('bridge_jobs')
    .update({
      status: 'running',
      claimedAt,
      claimedBy: user.displayName || user.id,
    })
    .eq('id', candidate.id)
    .eq('status', candidate.status)  // CAS guard against races
    .select()
    .maybeSingle();
  if (updErr) { const e = new Error(updErr.message); e.status = 500; throw e; }
  if (!claimed) return res.status(200).json({ job: null });
  return res.status(200).json({ job: claimed });
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
// explicit heartbeat that /next writes on every bridge poll. "Online"
// means any user with a bridgeToken has a heartbeat within HEARTBEAT_FRESH_MS;
// the bridge polls every ~1.5 s, so 10 s gives ~6 polls of grace before
// the UI flips to offline.
const HEARTBEAT_FRESH_MS = 10_000;

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
