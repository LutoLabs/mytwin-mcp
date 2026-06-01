// /api/workspaces/:id/groups/:groupId — GET members, DELETE the group.
import { methodGuard } from '../../../../lib/twin-api.js';
import { requireTenant } from '../../../../lib/anon.js';
import { listGroupMembers, deleteGroup } from '../../../../lib/groups.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'DELETE'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  const { id, groupId } = req.query;
  try {
    if (req.method === 'DELETE') return res.status(200).json(await deleteGroup({ ctx, workspaceId: id, groupId }));
    return res.status(200).json(await listGroupMembers({ ctx, workspaceId: id, groupId }));
  } catch (err) {
    const s = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (s >= 500) console.error('[workspaces/group] error:', err?.message);
    return res.status(s).json({ error: s >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
