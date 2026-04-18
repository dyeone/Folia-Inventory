import { supabase, stripUser } from '../_lib/supabase.js';
import { hashPassword } from '../_lib/hash.js';
import { wrap, methodNotAllowed } from '../_lib/respond.js';

export default wrap(async (req, res) => {
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
});
