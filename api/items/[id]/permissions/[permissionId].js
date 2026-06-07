// DELETE /api/items/:id/permissions/:permissionId — revoke access to one item.
//
// Owner-only. The id may be an active grant's permission_id OR a pending
// invitation_id; revokeAccess resolves either, scoped to this item.

import { methodGuard, runTwin } from '../../../../lib/twin-api.js';
import { revokeAccess } from '../../../../lib/sharing.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['DELETE'])) return;

  const { id, permissionId } = req.query;
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'id is required in the path' });
  }
  if (typeof permissionId !== 'string' || !permissionId) {
    return res.status(400).json({ error: 'permissionId is required in the path' });
  }

    // Reject a malformed item id as not-found instead of letting Postgres throw
  // "invalid input syntax for type uuid" -> 500 (M1-class, found in e2e debug).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(404).json({ error: 'Item not found' });
  }

  return runTwin(req, res, {
    toolName: 'revoke_item_permission',
    fn: (ctx) => revokeAccess({ ownerCtx: ctx, itemId: id, id: permissionId }),
  });
}
