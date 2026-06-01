// GET /api/workspaces/invitations/:token — look up a pending workspace invite.
// Public: the token is the bearer secret. Returns the workspace name and type
// and the inviter, never anything sensitive.
import { methodGuard } from '../../../../lib/twin-api.js';
import { getWorkspaceInvitation } from '../../../../lib/workspaces.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const { token } = req.query;
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'token is required in the path' });
  try {
    const inv = await getWorkspaceInvitation(token);
    if (!inv) return res.status(404).json({ error: 'Invitation not found.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(inv);
  } catch (err) {
    console.error('[workspaces/invitation] error:', err?.message);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}
