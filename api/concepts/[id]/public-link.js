// /api/concepts/:id/public-link — manage the public link for one compiled
// concept page the caller owns.
//
//   GET    -> { active, url, slug } | { active: false }
//   POST   -> { url, slug, created_at }   (409 if the page is not fully sharable)
//   DELETE -> { revoked: true }
//
// A concept page can only be published when every source item is sharable
// (enforced in createPublicLink), so a public reader never sees private source
// material quoted in the compiled body.

import { methodGuard, runTwin } from '../../../lib/twin-api.js';
import { createPublicLink, getActivePublicLink, revokePublicLink } from '../../../lib/public-links.js';
import { logAudit } from '../../../lib/audit.js';

const OBJECT_TYPE = 'concept';

function publicUrl(slug) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return `${base}/p/${slug}`;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'DELETE'])) return;

  const { id } = req.query;
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required in the path' });

  return runTwin(req, res, {
    toolName: 'concept_public_link',
    fn: async (ctx) => {
      if (req.method === 'GET') {
        const link = await getActivePublicLink({ ctx, objectType: OBJECT_TYPE, objectId: id });
        if (!link) return { active: false };
        return { active: true, url: publicUrl(link.slug), slug: link.slug, view_count: link.view_count };
      }
      if (req.method === 'DELETE') {
        await revokePublicLink({ ctx, objectType: OBJECT_TYPE, objectId: id });
        return { revoked: true };
      }
      const link = await createPublicLink({ ctx, objectType: OBJECT_TYPE, objectId: id });
      await logAudit({ userId: ctx.userId, tenantId: ctx.tenantId, eventType: 'share_created',
        itemId: id, context: { share_type: 'public_link', object_type: OBJECT_TYPE } });
      return { url: publicUrl(link.slug), slug: link.slug, created_at: link.created_at };
    },
  });
}
