// Consolidated auth dispatcher. Vercel's Hobby plan caps a deployment at
// 12 serverless functions, so the five separate auth routes
// (has-users, register, login, session, change-password) are merged here
// and dispatched on `?action=` (GET) or body.action (POST).
//
// The client (src/api.js) sends action explicitly with each call.

import { supabase, stripUser } from './_lib/supabase.js';
import { hashPassword, verifyPassword } from './_lib/hash.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

export default wrap(async (req, res) => {
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;
  if (!action) { const e = new Error('action required'); e.status = 400; throw e; }

  switch (action) {
    case 'has-users': return hasUsers(req, res);
    case 'register': return register(req, res);
    case 'login': return login(req, res);
    case 'session': return session(req, res);
    case 'change-password': return changePassword(req, res);
    default: { const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e; }
  }
});

async function hasUsers(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });
  res.status(200).json({ hasAnyUsers: (count ?? 0) > 0 });
}

async function register(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const { username, password, displayName } = req.body || {};
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
    role: isFirst ? 'admin' : 'staff',
    createdAt: new Date().toISOString(),
    active: true,
  };

  const { error } = await supabase.from('users').insert(newUser);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }

  res.status(201).json({ user: stripUser(newUser) });
}

async function login(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) {
    const e = new Error('Username and password required'); e.status = 400; throw e;
  }

  const normalized = username.trim().toLowerCase();
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('username', normalized)
    .maybeSingle();

  if (!user) { const e = new Error('Invalid username or password'); e.status = 401; throw e; }
  if (!user.active) { const e = new Error('This account has been deactivated'); e.status = 403; throw e; }

  const { valid, needsRehash } = verifyPassword(password, user.passwordHash);
  if (!valid) { const e = new Error('Invalid username or password'); e.status = 401; throw e; }

  // Opportunistic upgrade from legacy SHA-256 to pbkdf2 — fire and forget.
  if (needsRehash) {
    supabase.from('users').update({ passwordHash: hashPassword(password) }).eq('id', user.id)
      .then(() => {}, () => {});
  }

  res.status(200).json({ user: stripUser(user) });
}

async function session(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const { userId } = req.body || {};
  if (!userId) { const e = new Error('userId required'); e.status = 400; throw e; }

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (!user || !user.active) { const e = new Error('Session not found'); e.status = 404; throw e; }
  res.status(200).json({ user: stripUser(user) });
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

  const { error } = await supabase
    .from('users')
    .update({ passwordHash: hashPassword(newPassword) })
    .eq('id', userId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }

  res.status(200).json({ ok: true });
}
