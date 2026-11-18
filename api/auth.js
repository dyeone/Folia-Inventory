// Consolidated auth dispatcher. Vercel's Hobby plan caps a deployment at
// 12 serverless functions, so the five separate auth routes
// (has-users, register, login, session, change-password) are merged here
// and dispatched on `?action=` (GET) or body.action (POST).
//
// The client (src/api.js) sends action explicitly with each call.

import { supabase, stripUser } from './_lib/supabase.js';
import { hashPassword, verifyPassword } from './_lib/hash.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { clearSessionCookie, issueSessionToken, sessionSecret, setSessionCookie } from './_lib/session.js';

const PUBLIC_ACTIONS = new Set(['GET:has-users', 'POST:register', 'POST:login', 'POST:logout']);

export default wrap(async (req, res) => {
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;
  if (!action) { const e = new Error('action required'); e.status = 400; throw e; }

  switch (action) {
    case 'has-users': return hasUsers(req, res);
    case 'register': return register(req, res);
    case 'login': return login(req, res);
    case 'session': return session(req, res);
    case 'logout': return logout(req, res);
    case 'change-password': return changePassword(req, res);
    default: { const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e; }
  }
}, { sessionRequired: req => !PUBLIC_ACTIONS.has(`${req.method}:${req.method === 'GET' ? req.query?.action : req.body?.action}`) });

async function hasUsers(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });
  res.status(200).json({ hasAnyUsers: (count ?? 0) > 0 });
}

async function register(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  sessionSecret(); // Fail before creating an account if the deployment has no key.
  const { username, password, displayName, registrationPassword } = req.body || {};

  // Gate new registrations behind a shared secret so random visitors
  // can't sign themselves up. REGISTRATION_PASSWORD must be set on the
  // deployment — fail closed if it's missing rather than fall back to
  // a hardcoded default, which would silently leave registration open
  // on a misconfigured environment.
  const expected = process.env.REGISTRATION_PASSWORD;
  if (!expected) {
    const e = new Error('Registration is disabled on this deployment');
    e.status = 503; throw e;
  }
  if (!registrationPassword || registrationPassword !== expected) {
    const e = new Error('Invalid registration password');
    e.status = 401; throw e;
  }

  if (!username?.trim()) { const e = new Error('Username required'); e.status = 400; throw e; }
  if (!password) { const e = new Error('Password required'); e.status = 400; throw e; }
  if (password.length < 6) { const e = new Error('Password must be at least 6 characters'); e.status = 400; throw e; }

  const normalized = username.trim().toLowerCase();
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('username', normalized)
    .maybeSingle();
  if (existing) { const e = new Error('Username already taken'); e.status = 409; throw e; }

  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });
  const isFirst = (count ?? 0) === 0;

  const newUser = {
    id: `${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
    username: normalized,
    displayName: displayName?.trim() || username.trim(),
    passwordHash: hashPassword(password),
    role: isFirst ? 'admin' : 'packer',
    createdAt: new Date().toISOString(),
    active: true,
    // The first account is the 3babes owner — give it every brand. Later staff
    // default to bae-gin; an admin grants additional brands in user management.
    brandIds: isFirst ? ['bae-gin', 'bae'] : ['bae-gin'],
  };

  const { error } = await supabase.from('users').insert(newUser);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }

  setSessionCookie(res, issueSessionToken(newUser));
  res.status(201).json({ user: stripUser(newUser) });
}

// Lock an account for this many minutes after this many failed attempts
// inside the lookback window. Tuned to be annoying to a guesser without
// punishing a real user who fat-fingers their password a few times.
const LOGIN_LOCKOUT_THRESHOLD = 10;
const LOGIN_LOCKOUT_WINDOW_MIN = 15;

async function recordAttempt(username, succeeded, ip) {
  // Best-effort — we never fail the login on a logging error.
  await supabase
    .from('auth_attempts')
    .insert({ username, succeeded, ip: ip || null })
    .then(() => {}, () => {});
}

async function isLockedOut(username) {
  const since = new Date(Date.now() - LOGIN_LOCKOUT_WINDOW_MIN * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('auth_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('username', username)
    .eq('succeeded', false)
    .gte('attemptedAt', since);
  return (count ?? 0) >= LOGIN_LOCKOUT_THRESHOLD;
}

async function login(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  sessionSecret();
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) {
    const e = new Error('Username and password required'); e.status = 400; throw e;
  }
  // Vercel forwards the original client IP in x-forwarded-for; first hop wins.
  const ip = (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || null;
  const normalized = username.trim().toLowerCase();

  if (await isLockedOut(normalized)) {
    const e = new Error(`Too many failed attempts — try again in ${LOGIN_LOCKOUT_WINDOW_MIN} minutes`);
    e.status = 429; throw e;
  }

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('username', normalized)
    .maybeSingle();

  if (!user) {
    await recordAttempt(normalized, false, ip);
    const e = new Error('Invalid username or password'); e.status = 401; throw e;
  }
  if (!user.active) { const e = new Error('This account has been deactivated'); e.status = 403; throw e; }

  const { valid, needsRehash } = verifyPassword(password, user.passwordHash);
  if (!valid) {
    await recordAttempt(normalized, false, ip);
    const e = new Error('Invalid username or password'); e.status = 401; throw e;
  }

  await recordAttempt(normalized, true, ip);

  // Finish the legacy upgrade before signing: sessions bind to passwordHash,
  // so an admin password reset invalidates every previously issued token.
  if (needsRehash) {
    const passwordHash = hashPassword(password);
    const { error } = await supabase.from('users').update({ passwordHash }).eq('id', user.id);
    if (!error) user.passwordHash = passwordHash;
  }

  const token = issueSessionToken(user);
  // Non-cookie clients explicitly request a Bearer after the SAME password
  // check. Normal browser login responses never expose the session to JS.
  if (req.body?.sessionMode === 'token') return res.status(200).json({ user: stripUser(user), sessionToken: token });
  setSessionCookie(res, token);
  res.status(200).json({ user: stripUser(user) });
}

async function session(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  res.status(200).json({ user: stripUser(req.authUser) });
}

async function logout(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}

async function changePassword(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const { userId, currentPassword, newPassword } = req.body || {};
  if (!userId || !currentPassword || !newPassword) {
    const e = new Error('userId, currentPassword, newPassword required'); e.status = 400; throw e;
  }
  if (newPassword.length < 6) {
    const e = new Error('New password must be at least 6 characters'); e.status = 400; throw e;
  }

  const { data: user } = await supabase
    .from('users')
    .select('passwordHash')
    .eq('id', userId)
    .maybeSingle();
  if (!user) { const e = new Error('User not found'); e.status = 404; throw e; }

  const { valid } = verifyPassword(currentPassword, user.passwordHash);
  if (!valid) { const e = new Error('Current password is incorrect'); e.status = 401; throw e; }

  const passwordHash = hashPassword(newPassword);
  const { error } = await supabase
    .from('users')
    .update({ passwordHash })
    .eq('id', userId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }

  // Keep this device signed in; all other password-bound sessions expire.
  setSessionCookie(res, issueSessionToken({ ...req.authUser, passwordHash }));
  res.status(200).json({ ok: true });
}
