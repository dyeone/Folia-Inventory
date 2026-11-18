// Small wrapper to make handlers consistent: catches errors and
// returns a JSON response with an HTTP status from err.status (or 500).
//
// Server errors (5xx) are logged with the request method/url for Vercel's
// function logs. Client errors (4xx) are not logged — they're expected.
import { supabase } from './supabase.js';
import { bindSessionActor, checkRequestOrigin, readSessionToken, sessionMatchesUser, sessionTokenFromRequest } from './session.js';

// Every /api response is dynamic and authenticated — never let the
// browser or any intermediary cache it. Without this header, Vercel's
// CDN started returning 304 Not Modified on repeat polls (bridge
// status/health), which the client treats as a failure (res.ok is
// false for 304) — surfacing as a red "Failed" pill on live scans
// that the bridge actually ran fine.
function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

// The Chrome extension's background worker calls the API from a
// chrome-extension:// origin. Its manifest lists the API host, which lets
// Chrome skip CORS; this is the fallback for an install whose manifest
// doesn't (a custom API domain, an older copy). Only extension origins are
// echoed — never `*`. A signed Bearer is required for private API calls;
// extension origins do not grant access by themselves.
function extensionCors(req, res) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || !origin.startsWith('chrome-extension://')) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

// Default closed: every API handler uses a verified session unless its own
// dispatcher explicitly opts a public or independently authenticated action out.
export function wrap(handler, { sessionRequired = true } = {}) {
  return async (req, res) => {
    noCache(res);
    if (extensionCors(req, res) && req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    try {
      const required = typeof sessionRequired === 'function' ? sessionRequired(req) : sessionRequired;
      if (required) {
        const { token, bearer } = sessionTokenFromRequest(req);
        const claims = readSessionToken(token);
        checkRequestOrigin(req, { bearer });
        const { data: user, error } = await supabase.from('users').select('*').eq('id', claims.sub).maybeSingle();
        if (error) throw Object.assign(new Error('Unable to verify session'), { status: 503 });
        if (!sessionMatchesUser(claims, user)) throw Object.assign(new Error('Session expired — sign in again'), { status: 401 });
        bindSessionActor(req, user);
      } else {
        checkRequestOrigin(req, { tokenLogin: req.body?.action === 'login' && req.body?.sessionMode === 'token' });
      }
      await handler(req, res);
    } catch (e) {
      const status = e?.status ?? 500;
      // Log any 5xx so a deploy regression shows up in Vercel logs without
      // needing to reach for the browser console first.
      if (status >= 500) {
        console.error(`[api ${req.method} ${req.url}]`, e?.message || e, e?.stack);
      }
      res.status(status).json({ error: e?.message || 'Server error' });
    }
  };
}

export function methodNotAllowed(res, allowed = []) {
  noCache(res);
  if (allowed.length) res.setHeader('Allow', allowed.join(', '));
  res.status(405).json({ error: 'Method not allowed' });
}
