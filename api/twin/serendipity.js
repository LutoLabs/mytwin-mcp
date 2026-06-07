// GET /api/twin/serendipity
//
// The "one optional gift" for the calm home: the most recent high-confidence
// ELABORATION the reconciler found between two of the user's own ideas. Powers
// the serendipity line + the single amber pulse on the home hero.
//
// Read-only, tenant-scoped (runTwin ctx). No writes, no cap. Returns null when
// there is no suitable connection — the caller hides the line entirely.
//
// Note: surfaces shadow-mode decisions too. A shadow ELABORATION still names a
// REAL connection (the reconciler genuinely found these two ideas related); it
// simply hasn't been written as a link. That is exactly the "two ideas found
// each other" moment, so it is honest to surface.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

const HIGH_CONFIDENCE = 0.8;

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'serendipity',
    fn: async (ctx) => {
      const db = getDB();

      // Most recent high-confidence ELABORATION with both endpoints present.
      const { data: rows } = await db
        .from('reconciliation_decisions')
        .select('incoming_item_id, candidate_item_id, direction, confidence, created_at')
        .eq('tenant_id', ctx.tenantId)
        .eq('relationship', 'ELABORATION')
        .gte('confidence', HIGH_CONFIDENCE)
        .not('candidate_item_id', 'is', null)
        .not('incoming_item_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(12);

      for (const r of rows || []) {
        // Hydrate both items; require both still ACTIVE (never surface a merged/
        // superseded/deleted item as a live connection).
        const { data: items } = await db
          .from('knowledge')
          .select('id, title, status')
          .in('id', [r.incoming_item_id, r.candidate_item_id])
          .eq('tenant_id', ctx.tenantId);

        const byId = new Map((items || []).map(it => [it.id, it]));
        const inc = byId.get(r.incoming_item_id);
        const cand = byId.get(r.candidate_item_id);
        if (!inc || !cand) continue;
        if (inc.status && inc.status !== 'active') continue;
        if (cand.status && cand.status !== 'active') continue;

        // 'elaborates' reads specific -> general. direction picks the parent.
        let from = inc, to = cand;                            // item_more_general: candidate is the general parent
        if (r.direction === 'fragment_more_general') { from = cand; to = inc; }

        return {
          from: { id: from.id, title: from.title || '(untitled)' },
          to:   { id: to.id,   title: to.title   || '(untitled)' },
          confidence: r.confidence,
          at: r.created_at,
        };
      }

      return null;   // no suitable connection -> caller hides the line
    },
  });
}
