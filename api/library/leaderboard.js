// GET /api/library/leaderboard
//
// The contribution leaderboard for this user's knowledge pool. Ranks every
// contributor by upvotes received (primary) then items authored (secondary).
// In a personal brain this returns the user themselves; in a shared workspace
// context it shows all contributors within the tenant.
//
// Any signed-in user may read it. The only server-derived identity use is
// flagging which row is "you" for the UI highlight.
//
// Response: { leaderboard: Row[], available: boolean, viewer_id }
//   Row = { user_id, email, contributions, upvotes_received, is_you }
//
// Degrades gracefully: if migration 023 has not been applied yet (the
// brain_leaderboard function is absent), returns an empty list with
// available:false rather than a 500.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'library_leaderboard',
    fn: async (ctx) => {
      const db = getDB();
      const { data, error } = await db.rpc('brain_leaderboard', {
        p_tenant_id: ctx.tenantId,
      });

      if (error) {
        // Pre-migration: the function does not exist yet. Treat as "not ready".
        if (/brain_leaderboard|does not exist|could not find|schema cache/i.test(error.message || '')) {
          return { leaderboard: [], available: false, viewer_id: ctx.userId };
        }
        throw new Error(error.message);
      }

      const rows = (data || []).map((r) => ({
        user_id:          r.user_id,
        email:            r.email,
        contributions:    Number(r.contributions) || 0,
        upvotes_received: Number(r.upvotes_received) || 0,
        is_you:           r.user_id === ctx.userId,
      }));

      rows.sort((a, b) =>
        b.upvotes_received - a.upvotes_received ||
        b.contributions   - a.contributions   ||
        (a.email || '').localeCompare(b.email || ''),
      );

      return { leaderboard: rows, available: true, viewer_id: ctx.userId };
    },
  });
}
