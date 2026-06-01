// /api/workspaces/:id/members — GET list members, POST add a member by email.
import { methodGuard } from '../../../../lib/twin-api.js';
import { requireTenant } from '../../../../lib/anon.js';
import { listMembers, addMember, sendWorkspaceEmail } from '../../../../lib/workspaces.js';
import { logAudit } from '../../../../lib/audit.js';

function fail(res, err, tag) {
  const status = typeof err?.status === 'number' ? err.status : (err?.userFacing ? 400 : 500);
  if (status >= 500) console.error(tag, err?.message);
  return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Try again.' : err.message });
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireTenant(req);
  if (!ctx) return res.status(401).json({ error: 'Sign in first.' });
  if (ctx.isAnonymous) return res.status(403).json({ error: 'Sign in to use workspaces.' });
  const { id } = req.query;
  try {
    if (req.method === 'GET') return res.status(200).json(await listMembers({ ctx, workspaceId: id }));

    const { email, role } = req.body || {};
    const result = await addMember({ ctx, workspaceId: id, email, role });
    // Best-effort email; never block the response, never return the token.
    if (result.emailPayload) {
      try { await sendWorkspaceEmail(result.emailPayload); }
      catch (e) { console.error('[workspaces/members] email failed:', e?.message); }
    }
    logAudit({ userId: ctx.userId, tenantId: ctx.tenantId, eventType: 'workspace_member_added', success: true, context: { workspaceId: id, mode: result.mode } });
    return res.status(200).json({ added: true, mode: result.mode, email: result.email, role: result.role });
  } catch (err) { return fail(res, err, '[workspaces/members] error:'); }
}
