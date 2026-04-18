import { supabase, stripUser } from '../_lib/supabase.js';
import { verifyPassword, hashPassword } from '../_lib/hash.js';
import { wrap, methodNotAllowed } from '../_lib/respond.js';

export default wrap(async (req, res) => {
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
});
