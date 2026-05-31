// GET /api/library/shared — items other people have shared with this user.
//
// P1.4 "shared with you" indicator. Reuses the same grant resolver that
// permission-aware retrieval uses (lib/permissions.js), then reads the shared
// items' display fields. The rows live in the OWNER's tenant; the grant set is
// already access-checked, so reading them across tenants here is correct.
//
// Read-only and informational: it lists title, type, owner, level and date so
// the recipient can see what their twin can draw on. The actual use happens in
// chat retrieval. Never returns full item content.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getAccessibleSharedItems } from '../../lib/permissions.js';
import { getDB } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'list_shared_with_me',
    fn: async (ctx) => {
      const access = await getAccessibleSharedItems(ctx);
      const ids = [...access.idSet];
      if (!ids.length) return { items: [] };

      const db = getDB();
      const { data: rows, error } = await db
        .from('knowledge')
        .select('id, title, type, summary, created_at, user_id')
        .in('id', ids);
      if (error) {
        console.error('[library/shared] item lookup failed:', error.message);
        return { items: [] }; // fail closed
      }

      const ownerIds = [...new Set((rows || []).map(r => r.user_id))];
      let emailById = new Map();
      if (ownerIds.length) {
        const { data: owners } = await db.from('users').select('id, email').in('id', ownerIds);
        emailById = new Map((owners || []).map(u => [u.id, u.email]));
      }

      const items = (rows || [])
        .map(r => ({
          id:          r.id,
          title:       r.title,
          type:        r.type,
          summary:     r.summary || null,
          created_at:  r.created_at,
          level:       access.levelById.get(r.id) || 'can_use',
          owner_email: emailById.get(r.user_id) || null,
          shared:      true,
        }))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      return { items };
    },
  });
}
