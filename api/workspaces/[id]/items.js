// GET /api/workspaces/:id/items — items in this org workspace (members only).
import { methodGuard } from '../../../lib/twin-api.js';
import { requireTenant } from '../../../lib/anon.js';
import { listWorkspaceItems } from '../../../lib/contribution.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  try {
    return res.status(200).json(await listWorkspaceItems({ ctx, workspaceId: req.query.id, groupId: req.query.group_id || null }));
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (status >= 500) console.error('[workspaces/items] error:', err?.message);
    return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
