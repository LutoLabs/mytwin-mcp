// GET /api/items/:id/permissions — list who has access to one item.
//
// Owner-only. Returns active grants (resolved to recipient emails) plus any
// pending invitations that have not yet been accepted.

import { methodGuard, runTwin } from '../../../../lib/twin-api.js';
import { listItemPermissions } from '../../../../lib/sharing.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  const { id } = req.query;
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'id is required in the path' });
  }

    // Reject a malformed item id as not-found instead of letting Postgres throw
  // "invalid input syntax for type uuid" -> 500 (M1-class, found in e2e debug).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(404).json({ error: 'Item not found' });
  }

  return runTwin(req, res, {
    toolName: 'list_item_permissions',
    fn: (ctx) => listItemPermissions({ ownerCtx: ctx, itemId: id }),
  });
}
