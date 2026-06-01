// /api/workspaces/:id — GET workspace detail (members only).
import { methodGuard } from '../../../lib/twin-api.js';
import { requireTenant } from '../../../lib/anon.js';
import { getWorkspaceForMember, deleteWorkspace } from '../../../lib/workspaces.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'DELETE'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  try {
    if (req.method === 'DELETE') return res.status(200).json(await deleteWorkspace({ ctx, workspaceId: req.query.id }));
    return res.status(200).json(await getWorkspaceForMember({ ctx, workspaceId: req.query.id }));
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (status >= 500) console.error('[workspaces/detail] error:', err?.message);
    return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
