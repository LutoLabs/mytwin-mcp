// Phase 1 permission resolution for retrieval.
//
// The single user-visible Phase 1 feature is sharing one knowledge item with
// another person at one of five levels. Three of those levels make the item
// USABLE by the recipient's twin (not merely viewable in a UI):
//
//   can_view     read in a UI only          -> never enters retrieval
//   can_comment  read + comment in a UI      -> never enters retrieval
//   can_use      AI-native: the recipient's twin may retrieve and reason over it
//   can_edit     implies can_use
//   full_access  implies can_use
//
// A shared item's vector lives in the OWNER's Pinecone namespace
// (tenant_<ownerTenantId>), and its row stays under the owner's user_id /
// tenant_id. So permission-aware retrieval is cross-namespace: for each owner
// who shared something usable with this user, query that owner's namespace
// restricted to the granted item ids, then merge with the user's own results.
//
// This helper resolves exactly that grant set. It fails CLOSED: any error
// returns the empty set so a fault never widens access.

import { getDB } from './supabase.js';

// Ordered least -> most permissive. Index doubles as a rank for "keep the
// strongest grant" when an item is granted more than once.
export const USABLE_LEVELS = ['can_use', 'can_edit', 'full_access'];

function emptyAccess() {
  return { idSet: new Set(), byTenant: new Map(), levelById: new Map(), ownerById: new Map() };
}

// Resolve the items shared TO ctx.userId that their twin may retrieve.
//
// Returns:
//   idSet      Set<itemId>                       every accessible shared item id
//   byTenant   Map<ownerTenantId, itemId[]>      grouped for per-namespace Pinecone queries
//   levelById  Map<itemId, level>                strongest granted level per item
//   ownerById  Map<itemId, {userId, tenantId}>   owner of each shared item
//
// Phase 1 only creates item-level user grants (the share API inserts a
// permissions row with subject_user_id + object_item_id). Workspace-level and
// group-level grants exist in the schema but are not created in Phase 1, so we
// deliberately do NOT union them here yet: retrieval must surface only what the
// share feature explicitly granted, nothing more.
export async function getAccessibleSharedItems(ctx) {
  if (!ctx?.userId) return emptyAccess();

  // The legacy token-shared MCP surface sets visibilityFilter='sharable' and
  // views an OWNER's own sharable items. Phase 1 per-item grants must not leak
  // into that surface, so resolve no shared items there.
  if (ctx.visibilityFilter === 'sharable') return emptyAccess();

  const db = getDB();

  // 1) Explicit per-item grants to this user at a usable level.
  const { data: grants, error } = await db
    .from('permissions')
    .select('object_item_id, level')
    .eq('subject_user_id', ctx.userId)
    .not('object_item_id', 'is', null)
    .in('level', USABLE_LEVELS);
  if (error) {
    console.error('[permissions] grant lookup failed:', error.message);
    return emptyAccess(); // fail closed
  }
  if (!grants?.length) return emptyAccess();

  const levelById = new Map();
  for (const g of grants) {
    const prev = levelById.get(g.object_item_id);
    if (!prev || USABLE_LEVELS.indexOf(g.level) > USABLE_LEVELS.indexOf(prev)) {
      levelById.set(g.object_item_id, g.level);
    }
  }
  const ids = [...levelById.keys()];

  // 2) Resolve each item's owner (user_id + tenant_id). These ids are already
  //    access-checked above, so reading them across tenants is correct here.
  const { data: rows, error: rowErr } = await db
    .from('knowledge')
    .select('id, user_id, tenant_id')
    .in('id', ids);
  if (rowErr) {
    console.error('[permissions] owner lookup failed:', rowErr.message);
    return emptyAccess();
  }

  const idSet = new Set();
  const byTenant = new Map();
  const ownerById = new Map();
  for (const r of rows || []) {
    // A user can never be a cross-namespace recipient of their own item; if a
    // self-grant somehow exists, drop it so it is handled by the normal
    // own-namespace path (and never double-counted).
    if (r.user_id === ctx.userId) continue;
    idSet.add(r.id);
    ownerById.set(r.id, { userId: r.user_id, tenantId: r.tenant_id });
    if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, []);
    byTenant.get(r.tenant_id).push(r.id);
    // levelById already carries r.id from step 1.
  }

  return { idSet, byTenant, levelById, ownerById };
}

// Phase 2 workspace retrieval: the org workspaces this user is a member of.
// Membership is the authorisation, so a member may read the WHOLE workspace
// namespace (unlike per-item shares, which are restricted to granted ids).
//
// Returns:
//   byTenant      Map<workspaceTenantId, workspaceId>   one per org workspace
//
// One-directional: this only lets a member READ org namespaces. Nothing copies
// org content into the member's personal tenant (the ratchet holds).
export async function getMemberWorkspaces(ctx) {
  const empty = { byTenant: new Map() };
  if (!ctx?.userId) return empty;
  // The legacy token-shared surface must never surface org workspace content.
  if (ctx.visibilityFilter === 'sharable') return empty;

  const db = getDB();
  const { data: memberships, error } = await db
    .from('workspace_memberships')
    .select('workspaces!inner(id, type, tenant_id)')
    .eq('user_id', ctx.userId);
  if (error) {
    console.error('[permissions] workspace lookup failed:', error.message);
    return empty; // fail closed
  }

  const byTenant = new Map();
  for (const m of memberships || []) {
    const w = m.workspaces;
    if (!w || w.type !== 'organisational' || !w.tenant_id) continue;
    if (w.tenant_id === ctx.tenantId) continue; // never the user's own personal tenant
    byTenant.set(w.tenant_id, w.id);
  }
  return { byTenant };
}
