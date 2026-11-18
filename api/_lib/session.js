import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const COOKIE_NAME = 'folia-session';

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// A dedicated server-only key: never reuse a Shopify, Supabase or registration key.
export function sessionSecret() {
  const key = process.env.SESSION_SECRET;
  if (!key || Buffer.byteLength(key) < 32) throw fail(503, 'Session authentication is not configured');
  return key;
}

function sign(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function credentialVersion(user) {
  return sign(`credentials:${user.id}:${user.passwordHash}`);
}

export function issueSessionToken(user, now = Date.now()) {
  if (!user?.id || !user.passwordHash || !user.active) throw fail(401, 'Authentication required');
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, sub: user.id, iat, exp: iat + SESSION_TTL_SECONDS, cv: credentialVersion(user) })).toString('base64url');
  return `${payload}.${sign(`session:${payload}`)}`;
}

export function readSessionToken(token, now = Date.now()) {
  // Check configuration even when a request has no token; fail closed on deploys.
  sessionSecret();
  if (typeof token !== 'string' || token.length > 2048) throw fail(401, 'Sign in required');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw fail(401, 'Sign in required');
  const [payload, signature] = parts;
  const expected = Buffer.from(sign(`session:${payload}`));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fail(401, 'Sign in required');
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw fail(401, 'Sign in required'); }
  const seconds = Math.floor(now / 1000);
  if (claims?.v !== 1 || typeof claims.sub !== 'string' || !claims.sub || typeof claims.cv !== 'string'
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
    || claims.iat > seconds + 60 || claims.exp <= seconds || claims.exp - claims.iat !== SESSION_TTL_SECONDS) {
    throw fail(401, 'Session expired — sign in again');
  }
  return claims;
}

export function sessionMatchesUser(claims, user) {
  return !!user?.active && claims.sub === user.id && claims.cv === credentialVersion(user);
}

export function sessionTokenFromRequest(req) {
  const authorization = req.headers?.authorization;
  if (authorization) {
    const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization);
    if (!match) throw fail(401, 'Sign in required');
    return { token: match[1], bearer: true };
  }
  const cookies = (req.headers?.cookie || '').split(';').map(p => p.trim()).filter(p => p.startsWith(`${COOKIE_NAME}=`));
  if (cookies.length !== 1) return { token: null, bearer: false };
  return { token: cookies[0].slice(COOKIE_NAME.length + 1), bearer: false };
}

function cookieOptions() {
  const secure = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL_SECONDS}; ${cookieOptions()}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; ${cookieOptions()}`);
}

// SameSite=Lax is the cookie baseline; explicit cross-origin writes are rejected
// too. Extension requests use a password-issued Bearer and need no cookie access.
export function checkRequestOrigin(req, { bearer = false, tokenLogin = false } = {}) {
  if (bearer || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers?.origin;
  if (!origin) return; // CLI clients still have to present a signed token.
  if (tokenLogin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return;
  let source;
  try { source = new URL(origin); } catch { throw fail(403, 'Cross-origin request rejected'); }
  const host = req.headers?.host;
  const secure = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  if (source.host !== host || !['http:', 'https:'].includes(source.protocol) || (secure && source.protocol !== 'https:')) {
    throw fail(403, 'Cross-origin request rejected');
  }
}

// Keep the old handlers' parameter shapes, but derive both ACTOR fields from the
// verified session. Targets such as id/targetUserId must remain caller-selected.
export function bindSessionActor(req, user) {
  for (const source of [req.query, req.body]) {
    for (const field of ['userId', 'adminUserId']) {
      if (source?.[field] != null && source[field] !== user.id) throw fail(403, 'Session user does not match request');
    }
  }
  req.query = { ...(req.query || {}), userId: user.id, adminUserId: user.id };
  if (req.method !== 'GET' && req.method !== 'HEAD') req.body = { ...(req.body || {}), userId: user.id, adminUserId: user.id };
  req.authUser = user;
}
