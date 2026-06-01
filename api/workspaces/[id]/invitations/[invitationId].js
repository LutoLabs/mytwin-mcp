// DELETE /api/workspaces/:id/invitations/:invitationId — cancel a pending
// workspace invitation (owner/admin only).
import { methodGuard } from '../../../../lib/twin-api.js';
import { requireTenant } from '../../../../lib/anon.js';
import { cancelWorkspaceInvitation } from '../../../../lib/workspaces.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['DELETE'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  const { id, invitationId } = req.query;
  try {
    return res.status(200).json(await cancelWorkspaceInvitation({ ctx, workspaceId: id, invitationId }));
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (status >= 500) console.error('[workspaces/cancel-invite] error:', err?.message);
    return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
