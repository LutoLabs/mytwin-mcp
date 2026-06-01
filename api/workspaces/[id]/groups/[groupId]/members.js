// /api/workspaces/:id/groups/:groupId/members — POST add, DELETE remove.
// Body: { user_id }. Owner/admin only. The target must be a workspace member.
import { methodGuard } from '../../../../../lib/twin-api.js';
import { requireTenant } from '../../../../../lib/anon.js';
import { addGroupMember, removeGroupMember } from '../../../../../lib/groups.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST', 'DELETE'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  const { id, groupId } = req.query;
  const userId = (req.body || {}).user_id;
  try {
    if (req.method === 'DELETE') return res.status(200).json(await removeGroupMember({ ctx, workspaceId: id, groupId, userId }));
    return res.status(200).json(await addGroupMember({ ctx, workspaceId: id, groupId, userId }));
  } catch (err) {
    const s = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (s >= 500) console.error('[workspaces/group-members] error:', err?.message);
    return res.status(s).json({ error: s >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
