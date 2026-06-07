// /api/workspaces/:id/groups — GET list groups, POST create a group.
import { methodGuard } from '../../../../lib/twin-api.js';
import { requireTenant } from '../../../../lib/anon.js';
import { listGroups, createGroup } from '../../../../lib/groups.js';

function fail(res, err) {
  const s = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
  if (s >= 500) console.error('[workspaces/groups] error:', err?.message);
  return res.status(s).json({ error: s >= 500 ? 'Something went wrong. Try again.' : err.message });
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  const { id } = req.query;
  try {
    if (req.method === 'GET') return res.status(200).json(await listGroups({ ctx, workspaceId: id }));
    return res.status(201).json(await createGroup({ ctx, workspaceId: id, name: (req.body || {}).name, openness: (req.body || {}).openness }));
  } catch (err) { return fail(res, err); }
}
