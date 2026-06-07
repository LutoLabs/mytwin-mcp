// Profile v1 — shared resolution helpers for the Profile surface.
//
// Two endpoints consume this:
//   GET /api/profile            (api/profile/index.js)      — identity + stats + settings
//   GET /api/profile/hypergraph (api/profile/hypergraph.js) — the permission-scoped graph
//
// Workspace-bound from day one. The default target is the requester's personal
// workspace; the same helpers serve org/team workspaces in later phases without
// API changes.
//
// Permission model (Phase 1): an item is accessible to a non-owner only via an
// explicit per-item grant in the `permissions` table. USABLE_LEVELS (can_use and
// above) make an item appear in the graph. A grant below that threshold
// (can_view / can_comment) still proves a relationship to the workspace — so the
// viewer is allowed in (200) but sees an empty graph, never a 403. Fails CLOSED.

import { getDB } from './supabase.js';
import { USABLE_LEVELS, workspaceGroupDenials, groupRestrictedItemIds, isGroupMember, groupInWorkspace } from './permissions.js';

// The columns the graph + stats need. content is deliberately excluded — the
// Profile graph never ships item bodies across the trust boundary.
const ITEM_COLUMNS = 'id, user_id, tenant_id, workspace_id, title, type, provenance, tags, created_at';

// Resolve the requester's own personal workspace (the v1 default target).
export async function getPersonalWorkspace(db, userId) {
  const { data, error } = await db
    .from('workspaces')
    .select('id, tenant_id, type, name, owner_id, created_at')
    .eq('owner_id', userId)
    .eq('type', 'personal')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  return data || null;
}

export async function getWorkspaceById(db, workspaceId) {
  const { data, error } = await db
    .from('workspaces')
    .select('id, tenant_id, type, name, owner_id, created_at')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  return data || null;
}

// Is the requester a full-view member of the workspace (owner/admin/member)?
// Phase 1 only ever creates 'owner' memberships, but the role gate is written
// out so Phase 3 guests fall through to the recipient (granted-only) path.
async function membershipRole(db, workspaceId, userId) {
  const { data } = await db
    .from('workspace_memberships')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.role || null;
}

const FULL_VIEW_ROLES = new Set(['owner', 'admin', 'member']);

// Resolve what the requester may see in a workspace.
//
// Returns:
//   { access: 'full' | 'granted' | 'none', items: [...] }
//
//   full     requester owns the workspace (or is a full-view member) — sees every
//            item in the workspace. For the TRUE owner, items still carrying a null
//            workspace_id (inserted after the P1.2 backfill, before the insert path
//            stamps workspace_id) are folded in by user_id so they never vanish
//            from their owner's own Profile.
//   granted  requester is a share recipient — sees only items in this workspace
//            granted to them at USABLE_LEVELS. A view-only relationship yields an
//            empty item set but still counts as access (200, not 403).
//   none     no ownership, membership, or grant of any kind — caller returns 403.
export async function resolveAccessibleItems(db, { requesterId, workspace, groupId = null }) {
  const isOwner = workspace.owner_id === requesterId;
  const role = isOwner ? 'owner' : await membershipRole(db, workspace.id, requesterId);
  const effRole = isOwner ? 'owner' : role;

  if (isOwner || (role && FULL_VIEW_ROLES.has(role))) {
    // Full workspace view. Scope strictly by the workspace's tenant.
    let q = db.from('knowledge').select(ITEM_COLUMNS).eq('tenant_id', workspace.tenant_id);
    if (isOwner) {
      // workspace items OR this owner's still-unassigned (null) items.
      q = q.or(`workspace_id.eq.${workspace.id},and(workspace_id.is.null,user_id.eq.${requesterId})`);
    } else {
      q = q.eq('workspace_id', workspace.id);
    }
    const { data, error } = await q.order('created_at', { ascending: true });
    if (error) throw new Error(`item fetch failed: ${error.message}`);
    let items = data || [];

    // Phase 3 teamspace enforcement (the graph must match retrieval + the item list).
    if (groupId) {
      // The supplied group MUST belong to this workspace before it can drive any
      // access decision — reject a foreign/garbage group_id outright. The lookup
      // also returns the teamspace's openness, which gates entry.
      const grp = await groupInWorkspace(db, groupId, workspace.id);
      if (!grp) return { access: 'full', items: [], locked: true };
      // Teamspace scope: only this group's items, and only for those who may enter:
      // owner/admin always; an OPEN teamspace lets any workspace member in; a
      // closed/private one requires group membership. Others get an empty, locked
      // graph — visible but invitation-only.
      const canEnter = isOwner || role === 'admin' || grp.openness === 'open' || await isGroupMember(db, groupId, requesterId);
      if (!canEnter) return { access: 'full', items: [], locked: true };
      const groupItems = await groupRestrictedItemIds(db, groupId);
      items = items.filter(it => groupItems.has(it.id));
    } else {
      // Workspace scope: never surface items restricted to teamspaces the viewer
      // isn't in (owner/admin exempt). Fixes a prior leak where the graph showed
      // group-restricted items that retrieval + the item list already hid.
      const { deniedItemIds, failClosed } = await workspaceGroupDenials(db, workspace.id, requesterId, effRole);
      if (failClosed) return { access: 'full', items: [] };
      if (deniedItemIds.size) items = items.filter(it => !deniedItemIds.has(it.id));
    }
    return { access: 'full', items };
  }

  // Non-member: resolve this requester's per-item grants, then see which land in
  // THIS workspace. Any grant (even can_view) proves a relationship → access.
  const { data: grants, error: gErr } = await db
    .from('permissions')
    .select('object_item_id, level')
    .eq('subject_user_id', requesterId)
    .not('object_item_id', 'is', null);
  if (gErr) {
    console.error('[profile] grant lookup failed:', gErr.message);
    return { access: 'none', items: [] }; // fail closed
  }
  if (!grants?.length) return { access: 'none', items: [] };

  // Strongest level per item.
  const levelById = new Map();
  for (const g of grants) {
    const prev = levelById.get(g.object_item_id);
    if (!prev || rank(g.level) > rank(prev)) levelById.set(g.object_item_id, g.level);
  }
  const grantedIds = [...levelById.keys()];

  // Which granted items belong to this workspace? (Items live in the OWNER's
  // tenant, so do NOT re-filter by the requester's tenant here.)
  const { data: rows, error: rErr } = await db
    .from('knowledge')
    .select(ITEM_COLUMNS)
    .in('id', grantedIds)
    .eq('workspace_id', workspace.id);
  if (rErr) throw new Error(`granted item fetch failed: ${rErr.message}`);

  const inWorkspace = rows || [];
  if (inWorkspace.length === 0) return { access: 'none', items: [] };

  // Relationship exists. Usable items are the visible node set; view-only → empty.
  const usable = inWorkspace
    .filter(r => USABLE_LEVELS.includes(levelById.get(r.id)))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return { access: 'granted', items: usable };
}

function rank(level) {
  const i = USABLE_LEVELS.indexOf(level);
  // can_view / can_comment rank below 0 so usable levels always win.
  return i === -1 ? -1 : i;
}

// Concept-page count for a workspace. Only meaningful for the full (owner) view;
// concept pages are not shared per-item in Phase 1.
export async function countConceptPages(db, { workspace, isOwner }) {
  if (!isOwner) return 0;
  const { count } = await db
    .from('concept_pages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', workspace.tenant_id)
    .or(`workspace_id.eq.${workspace.id},and(workspace_id.is.null,user_id.eq.${workspace.owner_id})`);
  return count || 0;
}

// Resolve the workspace owner's identity for the Profile card.
export async function getOwnerIdentity(db, ownerId) {
  const { data } = await db
    .from('users')
    .select('id, email, created_at')
    .eq('id', ownerId)
    .maybeSingle();
  if (!data) return null;
  return {
    id:    data.id,
    name:  displayNameFromEmail(data.email),
    email: data.email,
    created_at: data.created_at,
  };
}

// Derive a human display name from an email local-part. No name column exists.
// "piotr@cfte.education" -> "Piotr"; "jack.smith@x.com" -> "Jack Smith".
export function displayNameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  const words = local.replace(/[._+-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return email || '';
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// YYYY-MM-DD for the member-since field.
export function isoDate(ts) {
  if (!ts) return null;
  return new Date(ts).toISOString().slice(0, 10);
}

// ── Empty-state placeholders (Sub-phase 4) ──────────────────────────────────
// Seven seed prompts shown only on the OWNER's own near-empty personal
// workspace. `domain` ties each slot to the render-spec palette (so the ghost
// node gets the right colour and a filled item lands in the right cluster);
// `tags` seed the created knowledge item. Ids are stable — they key the
// dismissal table, so never renumber them.
export const PLACEHOLDER_THRESHOLD = 5; // below this many items, show placeholders
export const PROFILE_PLACEHOLDERS = [
  { id: 'writing-voice',        label: 'Your writing voice',        domain: 'Voice & craft',              tags: ['voice', 'writing', 'tone'] },
  { id: 'brand-spec',           label: 'Your brand spec',           domain: 'Voice & craft',              tags: ['brand', 'design', 'identity'] },
  { id: 'operating-principles', label: 'Your operating principles', domain: 'Vision & positioning',       tags: ['principles', 'operating', 'vision'] },
  { id: 'key-frameworks',       label: 'Your key frameworks',       domain: 'Orchestration & automation', tags: ['frameworks', 'methodology', 'workflow'] },
  { id: 'professional-context', label: 'Your professional context', domain: 'Capability & clients',       tags: ['professional', 'context', 'clients'] },
  { id: 'projects-in-flight',   label: 'Your projects in flight',   domain: 'Roadmap & product build',    tags: ['projects', 'roadmap', 'build'] },
  { id: 'people-and-contacts',  label: 'Your people and contacts',  domain: 'Capability & clients',       tags: ['people', 'contacts', 'network'] },
];
const PLACEHOLDER_BY_ID = new Map(PROFILE_PLACEHOLDERS.map(p => [p.id, p]));
export function getPlaceholderDef(id) { return PLACEHOLDER_BY_ID.get(id) || null; }

// Which placeholder slots to render for this view. Only the workspace OWNER on a
// near-empty workspace sees any; recipients never do (returns []). Excludes slots
// already filled or dismissed (recorded in profile_placeholder_dismissals).
export async function getActivePlaceholders(db, { workspace, isOwner, itemCount }) {
  if (!isOwner) return [];
  if (itemCount >= PLACEHOLDER_THRESHOLD) return [];
  const { data, error } = await db
    .from('profile_placeholder_dismissals')
    .select('placeholder_id')
    .eq('workspace_id', workspace.id);
  if (error) {
    // Table missing or unreadable: fail toward showing the onboarding nudge,
    // but never leak — this path is owner-only already.
    console.error('[profile] placeholder dismissals lookup failed:', error.message);
  }
  const hidden = new Set((data || []).map(r => r.placeholder_id));
  // `slot` is the position in the canonical seven, so the client lays each ghost
  // node at a fixed golden-ratio anchor that doesn't shift as siblings dismiss.
  return PROFILE_PLACEHOLDERS
    .map((p, slot) => ({ id: p.id, label: p.label, domain: p.domain, tags: p.tags, slot }))
    .filter(p => !hidden.has(p.id));
}
export const PLACEHOLDER_SLOTS = PROFILE_PLACEHOLDERS.length;
