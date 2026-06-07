// /api/items/:id/public-link — manage the public (link-to-anyone) link for one
// knowledge item the caller owns.
//
//   GET    -> { active, url, slug } | { active: false }
//   POST   -> { url, slug, created_at }   (idempotent get-or-create)
//   DELETE -> { revoked: true }
//
// Owner-only (createPublicLink/getActivePublicLink/revokePublicLink resolve
// ownership against the caller's tenant). Distinct from /share (person-to-person
// email grants). The returned URL is the public storefront route /p/<slug>.

import { methodGuard, runTwin } from '../../../lib/twin-api.js';
import { createPublicLink, getActivePublicLink, revokePublicLink } from '../../../lib/public-links.js';
import { logAudit } from '../../../lib/audit.js';

const OBJECT_TYPE = 'item';

function publicUrl(slug) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return `${base}/p/${slug}`;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'DELETE'])) return;

  const { id } = req.query;
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required in the path' });

    // Reject a malformed item id as not-found instead of letting Postgres throw
  // "invalid input syntax for type uuid" -> 500 (M1-class, found in e2e debug).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(404).json({ error: 'Item not found' });
  }

  return runTwin(req, res, {
    toolName: 'item_public_link',
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
      // POST — create (or return existing) public link.
      const link = await createPublicLink({ ctx, objectType: OBJECT_TYPE, objectId: id });
      await logAudit({ userId: ctx.userId, tenantId: ctx.tenantId, eventType: 'share_created',
        itemId: id, context: { share_type: 'public_link', object_type: OBJECT_TYPE } });
      return { url: publicUrl(link.slug), slug: link.slug, created_at: link.created_at };
    },
  });
}
