// POST /api/twin/reconciliation-undo
//
// Reverse a reconciliation auto-action. Tenant-scoped: you can only undo your
// own tenant's decisions (reverseDecision filters by tenant_id). Idempotent —
// re-undoing a reverted decision is a no-op. Reversibility is structural: the
// before-state lives in the decision's reverse_token (migration 025), so no
// separate ledger is needed.
//
// Body (one of):
//   { "decision_id": "<uuid>" }        — reverse a single applied decision
//   { "incoming_item_id": "<uuid>" }   — reverse every applied decision for one fragment

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { getDB }                from '../../lib/supabase.js';
import { reverseDecision }      from '../../lib/reconciliation/executor.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  return runTwin(req, res, {
    toolName: 'reconciliation_undo',
    fn: async (ctx) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const decisionId     = body.decision_id || null;
      const incomingItemId = body.incoming_item_id || null;
      if (!decisionId && !incomingItemId) {
        const e = new Error('provide decision_id or incoming_item_id'); e.statusCode = 400; throw e;
      }

      if (decisionId) {
        const r = await reverseDecision({ decisionId, tenantId: ctx.tenantId });
        return { undone: r.reversed ? 1 : 0, results: [{ decisionId, ...r }] };
      }

      // Reverse every reverse-token-bearing decision for this fragment, newest first.
      const db = getDB();
      const { data: rows } = await db.from('reconciliation_decisions')
        .select('id').eq('tenant_id', ctx.tenantId).eq('incoming_item_id', incomingItemId)
        .not('reverse_token', 'is', null).order('created_at', { ascending: false });
      const results = [];
      for (const row of rows || []) {
        results.push({ decisionId: row.id, ...(await reverseDecision({ decisionId: row.id, tenantId: ctx.tenantId })) });
      }
      return { undone: results.filter(r => r.reversed).length, results };
    },
  });
}
