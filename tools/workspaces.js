// MCP tool implementations for workspace operations.
//
// Two tools are exposed:
//   listWorkspaces            — read-only, shows the caller's org workspaces
//   contributeItemsToWorkspace — write, batch-copies personal items into an org workspace
//
// Both call lib/workspaces.js and lib/contribution.js directly (the same
// functions the REST endpoints call) so all permission checks, RLS, and
// provenance handling are inherited, not duplicated.

import { listMyWorkspaces }        from '../lib/workspaces.js';
import { contributeToWorkspace }   from '../lib/contribution.js';

// Roles that are allowed to contribute (mirrors CONTRIBUTOR_ROLES in lib/contribution.js).
const CONTRIBUTOR_ROLES = new Set(['owner', 'admin', 'member']);

function userError(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

// ── list_workspaces ────────────────────────────────────────────────────────────
// Returns the caller's organisation workspaces with their role and member count.
// Use this to look up workspace IDs before calling contribute_to_workspace.

export async function listWorkspaces(ctx) {
  const { workspaces } = await listMyWorkspaces(ctx);
  return { workspaces };
}

// ── contribute_to_workspace ────────────────────────────────────────────────────
// Copies one or more personal items into an org workspace (personal → org only).
// Per-item errors are collected and returned; they never abort the whole batch.

export async function contributeItemsToWorkspace(ctx, { item_ids, workspace_id }) {
  if (!Array.isArray(item_ids) || item_ids.length === 0) {
    throw userError('At least one item_id is required.');
  }

  // Resolve workspace_id: auto-default when the caller belongs to exactly one
  // contributor-eligible org workspace; require explicit ID otherwise.
  let targetWorkspaceId = workspace_id;
  if (!targetWorkspaceId) {
    const { workspaces } = await listMyWorkspaces(ctx);
    const eligible = workspaces.filter(w => CONTRIBUTOR_ROLES.has(w.role));
    if (eligible.length === 0) {
      throw userError('You are not a member of any organisation workspace. Ask the workspace owner to add you first.');
    }
    if (eligible.length > 1) {
      const names = eligible.map(w => `${w.name} (id: ${w.id})`).join(', ');
      throw userError(`You belong to ${eligible.length} workspaces — specify workspace_id. Your workspaces: ${names}`);
    }
    targetWorkspaceId = eligible[0].id;
  }

  // Contribute each item individually; collect outcomes without aborting on failure.
  const results = [];
  for (const itemId of item_ids) {
    try {
      const r = await contributeToWorkspace({ ctx, workspaceId: targetWorkspaceId, itemId });
      results.push({
        item_id:           itemId,
        status:            'contributed',
        workspace_item_id: r.item_id,
        title:             r.title,
        type:              r.type,
      });
    } catch (err) {
      results.push({
        item_id: itemId,
        status:  'failed',
        reason:  err.message || 'Unknown error',
      });
    }
  }

  const contributed = results.filter(r => r.status === 'contributed').length;
  const failed      = results.filter(r => r.status === 'failed').length;

  return {
    workspace_id: targetWorkspaceId,
    contributed,
    failed,
    results,
  };
}
