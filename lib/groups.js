// Phase 3: permission groups — sub-workspace access control.
//
// Within an org workspace, an owner/admin can create named groups, put workspace
// members in them, and restrict specific items to one or more groups. An item
// with any group restriction is retrievable only by members of those groups;
// owner and admins always retain access. Items with no restriction stay
// workspace-wide (the default established in Phase 2).
//
// A restriction is stored as permissions rows: subject_group_id + object_item_id
// at level can_use. The presence of any such row for an item means "restricted".
// Retrieval enforcement lives in lib/permissions.getMemberWorkspaces (deniedItemIds).

import { getDB } from './supabase.js';

function gError(message, status) { const e = new Error(message); e.userFacing = true; if (status) e.status = status; return e; }
const MANAGE_ROLES = new Set(['owner', 'admin']);

async function membershipOf(db, workspaceId, userId) {
  const { data } = await db.from('workspace_memberships').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  return data || null;
}
async function requireManager(db, workspaceId, userId) {
  const mem = await membershipOf(db, workspaceId, userId);
  if (!mem) throw gError('Workspace not found.', 404);
  if (!MANAGE_ROLES.has(mem.role)) throw gError('Only an owner or admin can manage groups.', 403);
  return mem;
}
async function requireMember(db, workspaceId, userId) {
  const mem = await membershipOf(db, workspaceId, userId);
  if (!mem) throw gError('Workspace not found.', 404);
  return mem;
}
async function assertGroupInWorkspace(db, workspaceId, groupId) {
  const { data: g } = await db.from('permission_groups').select('id').eq('id', groupId).eq('workspace_id', workspaceId).maybeSingle();
  if (!g) throw gError('Group not found.', 404);
}

export async function createGroup({ ctx, workspaceId, name }) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw gError('A group name is required.', 400);
  if (trimmed.length > 60) throw gError('That group name is too long.', 400);
  const db = getDB();
  await requireManager(db, workspaceId, ctx.userId);
  const { data, error } = await db.from('permission_groups')
    .insert({ workspace_id: workspaceId, name: trimmed, created_by: ctx.userId })
    .select('id, name, created_at').single();
  if (error) throw gError('Could not create the group.', 500);
  return { id: data.id, name: data.name, member_count: 0, created_at: data.created_at };
}

export async function listGroups({ ctx, workspaceId }) {
  const db = getDB();
  const mem = await requireMember(db, workspaceId, ctx.userId);
  const { data: groups } = await db.from('permission_groups').select('id, name, created_at').eq('workspace_id', workspaceId);
  const ids = (groups || []).map(g => g.id);
  const counts = new Map();
  const myGroups = new Set();
  if (ids.length) {
    const { data: gm } = await db.from('permission_group_members').select('group_id, user_id').in('group_id', ids);
    (gm || []).forEach(r => { counts.set(r.group_id, (counts.get(r.group_id) || 0) + 1); if (r.user_id === ctx.userId) myGroups.add(r.group_id); });
  }
  return {
    groups: (groups || []).map(g => ({ id: g.id, name: g.name, member_count: counts.get(g.id) || 0, you_are_in: myGroups.has(g.id), created_at: g.created_at }))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    can_manage: MANAGE_ROLES.has(mem.role),
  };
}

export async function listGroupMembers({ ctx, workspaceId, groupId }) {
  const db = getDB();
  await requireMember(db, workspaceId, ctx.userId);
  await assertGroupInWorkspace(db, workspaceId, groupId);
  const { data: gm } = await db.from('permission_group_members').select('user_id').eq('group_id', groupId);
  const ids = (gm || []).map(r => r.user_id);
  let emailById = new Map();
  if (ids.length) { const { data: users } = await db.from('users').select('id, email').in('id', ids); emailById = new Map((users || []).map(u => [u.id, u.email])); }
  return { members: ids.map(id => ({ user_id: id, email: emailById.get(id) || null })) };
}

export async function addGroupMember({ ctx, workspaceId, groupId, userId }) {
  if (!userId) throw gError('A user id is required.', 400);
  const db = getDB();
  await requireManager(db, workspaceId, ctx.userId);
  await assertGroupInWorkspace(db, workspaceId, groupId);
  if (!(await membershipOf(db, workspaceId, userId))) throw gError('That person is not a member of the workspace.', 400);
  const { data: existing } = await db.from('permission_group_members').select('group_id').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
  if (!existing) await db.from('permission_group_members').insert({ group_id: groupId, user_id: userId });
  return { added: true, group_id: groupId, user_id: userId };
}

export async function removeGroupMember({ ctx, workspaceId, groupId, userId }) {
  if (!userId) throw gError('A user id is required.', 400);
  const db = getDB();
  await requireManager(db, workspaceId, ctx.userId);
  await assertGroupInWorkspace(db, workspaceId, groupId);
  await db.from('permission_group_members').delete().eq('group_id', groupId).eq('user_id', userId);
  return { removed: true, group_id: groupId, user_id: userId };
}

export async function deleteGroup({ ctx, workspaceId, groupId }) {
  const db = getDB();
  await requireManager(db, workspaceId, ctx.userId);
  await assertGroupInWorkspace(db, workspaceId, groupId);
  // Cascades permission_group_members and the group's permissions rows, so any
  // item restricted only to this group becomes workspace-wide again.
  await db.from('permission_groups').delete().eq('id', groupId);
  return { deleted: true, group_id: groupId };
}

// Set the groups an item is restricted to. An empty list clears restrictions
// (item becomes workspace-wide). Owner/admin only; item must be in the workspace.
export async function setItemGroups({ ctx, workspaceId, itemId, groupIds }) {
  const db = getDB();
  await requireManager(db, workspaceId, ctx.userId);
  const { data: item } = await db.from('knowledge').select('id, workspace_id').eq('id', itemId).maybeSingle();
  if (!item || item.workspace_id !== workspaceId) throw gError('Item not found in this workspace.', 404);

  const ids = Array.isArray(groupIds) ? [...new Set(groupIds.filter(Boolean))] : [];
  if (ids.length) {
    const { data: valid } = await db.from('permission_groups').select('id').eq('workspace_id', workspaceId).in('id', ids);
    const validSet = new Set((valid || []).map(g => g.id));
    for (const gid of ids) if (!validSet.has(gid)) throw gError('A selected group is not in this workspace.', 400);
  }
  // Replace existing group grants for this item.
  await db.from('permissions').delete().eq('object_item_id', itemId).not('subject_group_id', 'is', null);
  if (ids.length) {
    const rows = ids.map(gid => ({ subject_group_id: gid, object_item_id: itemId, level: 'can_use', granted_by: ctx.userId }));
    const { error } = await db.from('permissions').insert(rows);
    if (error) throw gError('Could not set restrictions.', 500);
  }
  return { item_id: itemId, group_ids: ids, restricted: ids.length > 0 };
}

export async function getItemGroups({ ctx, workspaceId, itemId }) {
  const db = getDB();
  await requireMember(db, workspaceId, ctx.userId);
  const { data: grants } = await db.from('permissions').select('subject_group_id').eq('object_item_id', itemId).not('subject_group_id', 'is', null);
  const groupIds = (grants || []).map(g => g.subject_group_id);
  return { item_id: itemId, group_ids: groupIds, restricted: groupIds.length > 0 };
}
