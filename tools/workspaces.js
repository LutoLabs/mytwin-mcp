// Workspace tool implementations — shared by the MCP surface and the standalone chat.
//
// Exported functions:
//   listWorkspaces            — read-only, shows the caller's org workspaces (MCP tool)
//   contributeItemsToWorkspace — write, batch by explicit IDs (MCP tool)
//   bulkContribute            — write, scope-based bulk contribute (chat + REST endpoint)
//
// All functions call lib/workspaces.js and lib/contribution.js directly so
// permission checks, RLS, and provenance handling are inherited, not duplicated.

import { listMyWorkspaces }        from '../lib/workspaces.js';
import { contributeToWorkspace }   from '../lib/contribution.js';
import { getDB }                   from '../lib/supabase.js';

// Roles that are allowed to contribute (mirrors CONTRIBUTOR_ROLES in lib/contribution.js).
const CONTRIBUTOR_ROLES = new Set(['owner', 'admin', 'member']);

function userError(message, status) {
  const e = new Error(message);
  e.userFacing = true;
  if (status) e.status = status;
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

// ── bulkContribute ─────────────────────────────────────────────────────────────
// Scope-based bulk contribute used by the standalone chat and its REST endpoint.
//
// Supports:
//   scope: 'all'           — every personal item in the user's tenant
//   scope: 'by-type'       — personal items of a specific type
//   scope: 'by-tag'        — personal items carrying a specific tag
//   item_ids               — explicit IDs (overrides scope)
//
// When dry_run=true: resolves the set and returns a count without writing anything.
// When dry_run=false: contributes all resolved items; per-item errors never abort the batch.
//
// Inherits ALL permission checks from contributeToWorkspace (membership, role,
// workspace type, item ownership). Never bypasses them.

export async function bulkContribute(ctx, {
  scope        = 'all',
  scope_type,
  scope_tag,
  item_ids,
  workspace_id,
  dry_run      = false,
} = {}) {
  // ── Resolve workspace ──────────────────────────────────────────────────────
  const { workspaces } = await listMyWorkspaces(ctx);
  const eligible = workspaces.filter(w => CONTRIBUTOR_ROLES.has(w.role));
  if (eligible.length === 0) {
    throw userError('You are not a member of any organisation workspace.', 403);
  }
  let ws;
  if (workspace_id) {
    ws = eligible.find(w => w.id === workspace_id);
    if (!ws) throw userError('Workspace not found, or you do not have access to it.', 404);
  } else if (eligible.length === 1) {
    ws = eligible[0];
  } else {
    const names = eligible.map(w => `${w.name} (id: ${w.id})`).join(', ');
    throw userError(`You belong to ${eligible.length} workspaces — specify workspace_id. Your workspaces: ${names}`, 400);
  }

  // ── Resolve item set (server-side — never from chat context) ───────────────
  const db = getDB();
  let ids;
  if (Array.isArray(item_ids) && item_ids.length > 0) {
    ids = item_ids;
  } else {
    // Only personal items (tenant_id = caller's own tenant, workspace_id IS NULL).
    let q = db.from('knowledge')
      .select('id')
      .eq('user_id',   ctx.userId)
      .eq('tenant_id', ctx.tenantId)
      .is('workspace_id', null);
    if (scope === 'by-type' && scope_type) q = q.eq('type', scope_type);
    if (scope === 'by-tag'  && scope_tag)  q = q.contains('tags', [scope_tag]);
    const { data } = await q;
    ids = (data || []).map(r => r.id);
  }

  // ── Dry run: count only ────────────────────────────────────────────────────
  if (dry_run) {
    return {
      dry_run:        true,
      workspace_id:   ws.id,
      workspace_name: ws.name,
      total:          ids.length,
      scope,
      scope_type:     scope_type || null,
      scope_tag:      scope_tag  || null,
    };
  }

  // ── Contribute each item ───────────────────────────────────────────────────
  const results = [];
  for (const itemId of ids) {
    try {
      const r = await contributeToWorkspace({ ctx, workspaceId: ws.id, itemId });
      results.push({ item_id: itemId, status: 'contributed', workspace_item_id: r.item_id, title: r.title, type: r.type });
    } catch (err) {
      results.push({ item_id: itemId, status: 'failed', reason: err.message || 'Unknown error' });
    }
  }

  const contributed = results.filter(r => r.status === 'contributed').length;
  const failed      = results.filter(r => r.status === 'failed').length;

  return {
    dry_run:        false,
    workspace_id:   ws.id,
    workspace_name: ws.name,
    contributed,
    failed,
    results,
  };
}
