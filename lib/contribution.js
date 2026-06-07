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
import { workspaceGroupDenials, groupRestrictedItemIds, isGroupMember, groupInWorkspace } from './permissions.js';

const MANAGE_ROLES = new Set(['owner', 'admin']);

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

// The Phase 3 group-restriction resolver now lives in lib/permissions.js so the
// graph (lib/profile.js) and this read surface enforce teamspace access identically.

// List the items in an org workspace (members only), with full content for a
// readable member-facing view. Membership is verified server-side, and the
// Phase 3 group-restriction filter is applied BEFORE content is exposed.
//
// With `groupId` (a teamspace = permission_group), returns only that group's
// exclusive content, and only if the caller may enter it (owner/admin or a
// member of the group); a non-member sees an empty set (the teamspace is
// "closed": visible in the list, but its content is invitation-only).
export async function listWorkspaceItems({ ctx, workspaceId, groupId = null, limit = 100 }) {
  const db = getDB();
  const mem = await membershipOf(db, workspaceId, ctx.userId);
  if (!mem) throw cError('Workspace not found.', 404);

  let keepItemId; // predicate: which items this caller may see

  if (groupId) {
    // The group MUST belong to this workspace before it gates anything (reject a
    // foreign/garbage group_id outright, mirroring lib/groups.js). The lookup also
    // returns openness, which gates entry.
    const grp = await groupInWorkspace(db, groupId, workspaceId);
    if (!grp) return { your_role: mem.role, items: [] };
    // Teamspace scope: gate entry (owner/admin always; OPEN lets any member in;
    // closed/private requires group membership), then restrict to the group's items.
    const canEnter = MANAGE_ROLES.has(mem.role) || grp.openness === 'open' || await isGroupMember(db, groupId, ctx.userId);
    if (!canEnter) return { your_role: mem.role, items: [] };
    const groupItems = await groupRestrictedItemIds(db, groupId);
    keepItemId = (id) => groupItems.has(id);
  } else {
    // Workspace scope: drop items restricted to groups the caller isn't in.
    const { deniedItemIds, failClosed } = await workspaceGroupDenials(db, workspaceId, ctx.userId, mem.role);
    if (failClosed) {
      console.error('[contribution] group-restriction resolution failed; returning no items (fail closed)', { workspaceId, userId: ctx.userId });
      return { your_role: mem.role, items: [] };
    }
    keepItemId = (id) => !deniedItemIds.has(id);
  }

  const { data: rows } = await db.from('knowledge')
    .select('id, title, type, tags, content, provenance, created_at, user_id')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 100, 200));

  // Drop any item the caller is not entitled to see under the active scope.
  const visible = (rows || []).filter(r => keepItemId(r.id));

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
