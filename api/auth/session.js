import { supabase, stripUser } from '../_lib/supabase.js';
import { wrap, methodNotAllowed } from '../_lib/respond.js';

// Resolves a stored user id to the current user row (or 404 if deleted/deactivated).
export default wrap(async (req, res) => {
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
});
