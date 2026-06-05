// GET /api/twin/reconciliation-stats?days=30
//
// Tenant-scoped reconciliation telemetry (§15). Read-only over the decision log.
// Lets the owner review what the (shadow-mode) reconciler has been deciding
// before any auto-action is enabled. No cap consumed; no writes.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { reconciliationStats }   from '../../lib/reconciliation/stats.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  return runTwin(req, res, {
    toolName: 'reconciliation_stats',
    fn: async (ctx) => {
      const days = Math.min(Math.max(Number(req.query?.days) || 30, 1), 365);
      return reconciliationStats({ tenantId: ctx.tenantId, sinceDays: days });
    },
  });
}
