// /api/workspaces/:id/members/:userId — DELETE remove a member, PATCH change role.
import { methodGuard } from '../../../../lib/twin-api.js';
import { requireTenant } from '../../../../lib/anon.js';
import { removeMember, changeMemberRole } from '../../../../lib/workspaces.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['DELETE', 'PATCH'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  const { id, userId } = req.query;
  try {
    if (req.method === 'DELETE') {
      return res.status(200).json(await removeMember({ ctx, workspaceId: id, userId }));
    }
    const { role } = req.body || {};
    return res.status(200).json(await changeMemberRole({ ctx, workspaceId: id, userId, role }));
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (status >= 500) console.error('[workspaces/member] error:', err?.message);
    return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
