// GET /api/twin/review-presence
//
// The "one whisper" for the calm home: whether anything is waiting in the review
// queue. PRESENCE ONLY — never a count (a count would read as a demand/badge,
// which the home page's one design rule forbids). The caller shows a single
// faint, count-less line only when pending is true.
//
// Read-only, tenant-scoped (runTwin ctx). No writes, no cap.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'review_presence',
    fn: async (ctx) => {
      const db = getDB();
      // head:true + limit:1 — we only need existence, not a tally.
      const { count } = await db
        .from('review_items')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', ctx.tenantId)
        .eq('user_id', ctx.userId)
        .eq('state', 'pending')
        .limit(1);
      return { pending: (count || 0) > 0 };
    },
  });
}
