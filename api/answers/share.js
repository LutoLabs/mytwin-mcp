// /api/answers/share — publish a twin chat answer as a public artifact.
//
//   POST { title?, content, citations? } -> { url, slug, answer_id }
//   DELETE { answer_id }                 -> { revoked: true }
//
// The user has the answer on screen and is explicitly choosing to publish that
// text. We snapshot it into shared_answers (dash-cleaned) and mint a public
// link. Rate-limited because it creates rows on an unauthenticated-adjacent path.

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { createSharedAnswerLink, revokePublicLink } from '../../lib/public-links.js';
import { checkRateLimit } from '../../lib/rate-limit.js';
import { logAudit } from '../../lib/audit.js';

const ANSWER_SHARE_PER_HOUR = 30;

function publicUrl(slug) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return `${base}/p/${slug}`;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST', 'DELETE'])) return;

  return runTwin(req, res, {
    toolName: 'answer_share',
    fn: async (ctx) => {
      if (req.method === 'DELETE') {
        const { answer_id } = req.body || {};
        if (typeof answer_id !== 'string' || !answer_id) throw new HttpError(400, { error: 'answer_id is required' });
        await revokePublicLink({ ctx, objectType: 'answer', objectId: answer_id });
        return { revoked: true };
      }

      const rl = await checkRateLimit(`answer-share:${ctx.userId}`, ANSWER_SHARE_PER_HOUR);
      if (rl.exceeded) throw new HttpError(429, { error: 'Too many shares this hour. Try again shortly.' });

      const { title, content, citations } = req.body || {};
      const link = await createSharedAnswerLink({ ctx, title, content, citations });
      await logAudit({ userId: ctx.userId, tenantId: ctx.tenantId, eventType: 'share_created',
        itemId: link.objectId, context: { share_type: 'public_link', object_type: 'answer' } });
      return { url: publicUrl(link.slug), slug: link.slug, answer_id: link.objectId };
    },
  });
}
