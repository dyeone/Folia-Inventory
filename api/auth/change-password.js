import { supabase } from '../_lib/supabase.js';
import { hashPassword, verifyPassword } from '../_lib/hash.js';
import { wrap, methodNotAllowed } from '../_lib/respond.js';

export default wrap(async (req, res) => {
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
});
