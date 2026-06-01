// POST /api/workspaces/invitations/:token/accept — accept a workspace invite.
// Public, token-gated, single-use. Provisions the recipient's account if needed,
// adds the workspace membership (as 'member'), and signs them in via the cookie.
import { methodGuard } from '../../../../lib/twin-api.js';
import { acceptWorkspaceInvitation } from '../../../../lib/workspaces.js';
import { setSessionCookie } from '../../../../lib/auth.js';
import { logAudit } from '../../../../lib/audit.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const { token } = req.query;
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'token is required in the path' });
  try {
    const result = await acceptWorkspaceInvitation(token);
    setSessionCookie(res, result.sessionJwt);
    logAudit({ userId: result.user.id, tenantId: result.user.tenant_id || null, eventType: 'workspace_invitation_accepted', success: true, context: { workspaceId: result.workspaceId } });
    return res.status(200).json({ accepted: true, workspace_id: result.workspaceId, email: result.user.email });
  } catch (err) {
    const status = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
    if (status >= 500) console.error('[workspaces/accept] error:', err?.message);
    logAudit({ eventType: 'workspace_invitation_accepted', success: false, errorType: `HTTP${status}`, errorMsg: err?.message });
    return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
  }
}
