// /api/workspaces/:id/items/:itemId/groups — GET an item's group restrictions,
// PUT to set them. Body for PUT: { group_ids: [...] }. Empty list clears the
// restriction (item becomes workspace-wide). Owner/admin only for PUT.
import { methodGuard } from '../../../../../lib/twin-api.js';
import { requireTenant } from '../../../../../lib/anon.js';
import { getItemGroups, setItemGroups } from '../../../../../lib/groups.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PUT'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  const { id, itemId } = req.query;
  try {
    if (req.method === 'PUT') return res.status(200).json(await setItemGroups({ ctx, workspaceId: id, itemId, groupIds: (req.body || {}).group_ids }));
    return res.status(200).json(await getItemGroups({ ctx, workspaceId: id, itemId }));
  } catch (err) {
    const s = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (s >= 500) console.error('[workspaces/item-groups] error:', err?.message);
    return res.status(s).json({ error: s >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
