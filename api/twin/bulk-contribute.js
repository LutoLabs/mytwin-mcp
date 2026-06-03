// POST /api/twin/bulk-contribute
//
// Server-side set-based contribute: copies the caller's personal knowledge items
// into an org workspace without being limited by what the chat has in context.
//
// Body:
//   {
//     scope?:        'all' | 'by-type' | 'by-tag'  (default: 'all')
//     scope_type?:   string  — used when scope='by-type'
//     scope_tag?:    string  — used when scope='by-tag'
//     item_ids?:     string[] — explicit IDs; overrides scope
//     workspace_id?: string  — auto-resolved if caller has exactly one eligible workspace
//     dry_run?:      boolean — if true, return count only without writing (default: false)
//   }
//
// Returns (dry_run=true):
//   { dry_run: true, workspace_id, workspace_name, total, scope, scope_type, scope_tag }
//
// Returns (dry_run=false):
//   { dry_run: false, workspace_id, workspace_name, contributed, failed, results }
//
// All permission checks (membership, role, workspace type, item ownership) are
// enforced inside bulkContribute → contributeToWorkspace. Never bypassed here.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { bulkContribute }        from '../../tools/workspaces.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  return runTwin(req, res, {
    toolName: 'bulk_contribute',
    fn: async (ctx) => {
      if (ctx.isAnonymous) {
        const e = new Error('Sign in to contribute to workspaces.');
        e.userFacing = true;
        e.status = 403;
        throw e;
      }

      const {
        scope,
        scope_type,
        scope_tag,
        item_ids,
        workspace_id,
        dry_run,
      } = req.body || {};

      return bulkContribute(ctx, {
        scope,
        scope_type,
        scope_tag,
        item_ids,
        workspace_id,
        dry_run: dry_run === true,
      });
    },
  });
}
