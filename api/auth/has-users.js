import { supabase } from '../_lib/supabase.js';
import { wrap, methodNotAllowed } from '../_lib/respond.js';

export default wrap(async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });
  res.status(200).json({ hasAnyUsers: (count ?? 0) > 0 });
});
