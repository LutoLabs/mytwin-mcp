// POST /api/items/:id/share — share one knowledge item with a person by email.
//
// Body: { email: string, level: 'can_view'|'can_comment'|'can_use'|'can_edit'|'full_access' }
//
// Owner-only. Existing-account recipients get an immediate grant + notification;
// new emails get a pending invitation + magic-link email. The invitation token
// is NEVER returned to the sharer (it is the recipient's bearer secret).

import { methodGuard, runTwin, HttpError } from '../../../lib/twin-api.js';
import { shareItemWithEmail, sendShareEmail } from '../../../lib/sharing.js';
import { checkRateLimit } from '../../../lib/rate-limit.js';

const SHARE_PER_HOUR = 30;

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { id } = req.query;
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'id is required in the path' });
  }
  const { email, level } = req.body || {};

    // Reject a malformed item id as not-found instead of letting Postgres throw
  // "invalid input syntax for type uuid" -> 500 (M1-class, found in e2e debug).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(404).json({ error: 'Item not found' });
  }

  return runTwin(req, res, {
    toolName: 'share_item',
    fn: async (ctx) => {
      // Sharing requires a durable, email-backed identity. Anonymous sessions
      // have no email and cannot be a granter.
      if (ctx.isAnonymous) throw new HttpError(403, { error: 'Sign in to share an item.' });

      const rl = await checkRateLimit(`share:${ctx.userId}`, SHARE_PER_HOUR);
      if (rl.exceeded) throw new HttpError(429, { error: 'Too many shares this hour. Try again shortly.' });

      const result = await shareItemWithEmail({ ownerCtx: ctx, itemId: id, email, level });

      // Best-effort delivery — a send failure must never void the grant.
      try { await sendShareEmail(result.email); }
      catch (e) { console.error('[items/share] email send failed:', e?.message); }

      // Sanitised body — never echo the invitation token back to the sharer.
      return {
        shared:    true,
        mode:      result.mode,          // 'granted' | 'invited'
        level:     result.level,
        recipient: result.recipientEmail,
        ...(result.mode === 'granted'
          ? { permission_id: result.permissionId }
          : { invitation_id: result.invitationId }),
      };
    },
  });
}
