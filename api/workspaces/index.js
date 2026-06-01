// /api/workspaces — GET list my org workspaces, POST create one.
import { methodGuard } from '../../lib/twin-api.js';
import { requireTenant } from '../../lib/anon.js';
import { createOrgWorkspace, listMyWorkspaces } from '../../lib/workspaces.js';
import { logAudit } from '../../lib/audit.js';

function fail(res, err) {
  const status = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
  if (status >= 500) console.error('[workspaces] error:', err?.message);
  return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  try {
    if (req.method === 'GET') return res.status(200).json(await listMyWorkspaces(ctx));
    const ws = await createOrgWorkspace({ ctx, name: (req.body || {}).name });
    logAudit({ userId: ctx.userId, tenantId: ctx.tenantId, eventType: 'workspace_created', success: true, context: { workspaceId: ws.id } });
    return res.status(201).json(ws);
  } catch (err) { return fail(res, err); }
}
