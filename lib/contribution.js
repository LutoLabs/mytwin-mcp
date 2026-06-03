// Phase 2: contribution (the asymmetric IP ratchet).
//
// A member copies one of their PERSONAL items into an org workspace. The copy
// lives in the workspace's own tenant and Pinecone namespace (workspace_id set),
// so org members can retrieve it. This is strictly one-directional: there is no
// function anywhere that copies workspace content back into a member's personal
// tenant. The ratchet is preserved by omission, exactly as migration 018 intended.

import { randomUUID } from 'node:crypto';
import { getDB } from './supabase.js';
import { getNamespace } from './pinecone.js';
import { embed } from './embed.js';

function cError(message, status) { const e = new Error(message); e.userFacing = true; if (status) e.status = status; return e; }
const CONTRIBUTOR_ROLES = new Set(['owner', 'admin', 'member']); // guests cannot contribute

async function membershipOf(db, workspaceId, userId) {
  const { data } = await db.from('workspace_memberships')
    .select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  return data || null;
}

// Copy a personal item into an org workspace. personal -> org only.
export async function contributeToWorkspace({ ctx, workspaceId, itemId }) {
  if (typeof itemId !== 'string' || !itemId) throw cError('An item id is required.', 400);
  const db = getDB();

  const mem = await membershipOf(db, workspaceId, ctx.userId);
  if (!mem) throw cError('Workspace not found.', 404);
  if (!CONTRIBUTOR_ROLES.has(mem.role)) throw cError('Guests cannot contribute to this workspace.', 403);

  const { data: ws } = await db.from('workspaces').select('id, tenant_id, type').eq('id', workspaceId).maybeSingle();
  if (!ws) throw cError('Workspace not found.', 404);
  if (ws.type !== 'organisational') throw cError('Items can only be contributed to organisation workspaces.', 400);

  // The source must be the contributor's own item.
  const { data: src } = await db.from('knowledge')
    .select('id, user_id, type, title, content, tags, source_type, source_ref, is_living_document, workspace_id')
    .eq('id', itemId).maybeSingle();
  if (!src) throw cError('Item not found.', 404);
  if (src.user_id !== ctx.userId) throw cError('You can only contribute items you own.', 403);
  if (src.workspace_id === workspaceId) throw cError('That item is already in this workspace.', 400);

  // Build the org-side copy. Provenance becomes 'organisational' so members see
  // it as shared org content, distinct from anyone's personal voice.
  const pid = randomUUID();
  const embedding = await embed(src.content);

  const { data: copy, error } = await db.from('knowledge').insert({
    user_id:      ctx.userId,        // who contributed it
    tenant_id:    ws.tenant_id,      // the ORG tenant -> the org namespace
    workspace_id: workspaceId,
    type:         src.type,
    title:        src.title,
    content:      src.content,
    tags:         src.tags || [],
    source_type:  src.source_type || 'contributed',
    source_ref:   src.source_ref || null,
    provenance:   'organisational',
    pinecone_id:  pid,
    is_living_document: Boolean(src.is_living_document),
  }).select('id, created_at, title, type').single();
  if (error) throw cError('Could not contribute the item.', 500);

  await getNamespace(ws.tenant_id).upsert([{
    id: pid,
    values: embedding,
    metadata: {
      knowledge_id:   copy.id,
      user_id:        ctx.userId,
      tenant_id:      ws.tenant_id,
      workspace_id:   workspaceId,
      type:           src.type,
      knowledge_type: src.type,
      provenance:     'organisational',
      source_type:    src.source_type || 'contributed',
      source_ref:     src.source_ref || '',
      created_at:     copy.created_at,
    },
  }]);

  return { contributed: true, workspace_id: workspaceId, item_id: copy.id, title: copy.title, type: copy.type };
}

// Group-restriction filter for the workspace read surface (Phase 3 groups).
//
// Governing rule: people see only what they were invited to; err toward
// under-exposure, never over. Per role:
//   owner / admin  exempt — they manage the workspace, they see everything in it.
//   member         denied = items granted to a permission group they are NOT in.
//   guest          least-privileged — denied = EVERY item that carries ANY group
//                  restriction (a guest sees only fully-unrestricted items).
//
// Fails CLOSED: if restrictions cannot be resolved for a non-manager, signal
// failClosed so the caller returns nothing rather than risk over-exposure.
async function workspaceGroupDenials(db, workspaceId, userId, role) {
  if (role === 'owner' || role === 'admin') {
    return { deniedItemIds: new Set(), failClosed: false };
  }

  const { data: groups, error: gErr } = await db
    .from('permission_groups').select('id').eq('workspace_id', workspaceId);
  if (gErr) return { deniedItemIds: new Set(), failClosed: true };
  if (!groups?.length) return { deniedItemIds: new Set(), failClosed: false }; // no restrictions exist

  const groupIds = groups.map(g => g.id);
  const [grantsRes, myGmRes] = await Promise.all([
    db.from('permissions').select('object_item_id, subject_group_id')
      .in('subject_group_id', groupIds).not('object_item_id', 'is', null),
    db.from('permission_group_members').select('group_id')
      .eq('user_id', userId).in('group_id', groupIds),
  ]);
  if (grantsRes.error || myGmRes.error) return { deniedItemIds: new Set(), failClosed: true };

  // item_id -> set of groups it is granted to (i.e. it IS restricted)
  const restricted = new Map();
  for (const g of grantsRes.data || []) {
    if (!restricted.has(g.object_item_id)) restricted.set(g.object_item_id, new Set());
    restricted.get(g.object_item_id).add(g.subject_group_id);
  }

  const denied = new Set();
  if (role === 'guest') {
    // Least-privileged: any restricted item is hidden, regardless of grants.
    for (const itemId of restricted.keys()) denied.add(itemId);
  } else {
    // member: hidden unless they belong to at least one granted group.
    const myGroups = new Set((myGmRes.data || []).map(r => r.group_id));
    for (const [itemId, allowed] of restricted) {
      let ok = false;
      for (const gid of allowed) if (myGroups.has(gid)) { ok = true; break; }
      if (!ok) denied.add(itemId);
    }
  }
  return { deniedItemIds: denied, failClosed: false };
}

// List the items in an org workspace (members only), with full content for a
// readable member-facing view. Membership is verified server-side, and the
// Phase 3 group-restriction filter is applied BEFORE content is exposed.
export async function listWorkspaceItems({ ctx, workspaceId, limit = 100 }) {
  const db = getDB();
  const mem = await membershipOf(db, workspaceId, ctx.userId);
  if (!mem) throw cError('Workspace not found.', 404);

  // Group-restriction filter (mandatory before exposing content). Fails closed:
  // if we cannot resolve restrictions for a non-manager, show nothing.
  const { deniedItemIds, failClosed } = await workspaceGroupDenials(db, workspaceId, ctx.userId, mem.role);
  if (failClosed) {
    console.error('[contribution] group-restriction resolution failed; returning no items (fail closed)', { workspaceId, userId: ctx.userId });
    return { items: [] };
  }

  const { data: rows } = await db.from('knowledge')
    .select('id, title, type, tags, content, provenance, created_at, user_id')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 100, 200));

  // Drop any item the caller is not entitled to see under group restrictions.
  const visible = (rows || []).filter(r => !deniedItemIds.has(r.id));

  const contributorIds = [...new Set(visible.map(r => r.user_id))];
  let emailById = new Map();
  if (contributorIds.length) {
    const { data: users } = await db.from('users').select('id, email').in('id', contributorIds);
    emailById = new Map((users || []).map(u => [u.id, u.email]));
  }
  return {
    your_role: mem.role,
    items: visible.map(r => ({
      id: r.id, title: r.title, type: r.type, tags: r.tags || [],
      content: r.content || '',
      provenance: r.provenance || 'organisational',
      created_at: r.created_at, contributor_email: emailById.get(r.user_id) || null,
    })),
  };
}
