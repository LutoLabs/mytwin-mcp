// POST /api/workspaces/:id/contribute — copy one of my items into the workspace.
// Body: { item_id }. One-directional (personal -> org). Members only, not guests.
import { methodGuard } from '../../../lib/twin-api.js';
import { requireTenant } from '../../../lib/anon.js';
import { contributeToWorkspace } from '../../../lib/contribution.js';
import { logAudit } from '../../../lib/audit.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  try {
    const result = await contributeToWorkspace({ ctx, workspaceId: req.query.id, itemId: (req.body || {}).item_id });
    logAudit({ userId: ctx.userId, tenantId: ctx.tenantId, eventType: 'workspace_contribution', success: true, context: { workspaceId: req.query.id, itemId: result.item_id } });
    return res.status(201).json(result);
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (status >= 500) console.error('[workspaces/contribute] error:', err?.message);
    return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
