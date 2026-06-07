// lib/data-access.js
//
// The single mandatory gateway for reading tenant-owned data. The app talks to
// Supabase with the service-role key, which BYPASSES Postgres RLS, so tenant
// isolation is entirely application-layer. This module makes the safe path the
// only path: a read is authorized in exactly one of two ways, and a read that
// provides neither is refused.
//
//   1. tenantRead(ctx, table)      — requires a resolved tenant. Every row is
//                                     scoped to ctx.tenantId + ctx.userId (plus
//                                     the visibility filter on the shared-MCP
//                                     surface). Throws if ctx has no tenant.
//   2. publicArtifactRead(slug)    — the ONLY tenantless read. Authorization is
//                                     the unguessable public_links slug; the
//                                     owner tenant is resolved from the link row,
//                                     never from the caller. Returns one
//                                     sanitized artifact or null.
//
// No endpoint should hand-roll an unscoped query. New reads go through here; the
// CI cross-tenant suite (api/admin/test-cross-tenant.js) is the backstop that
// catches any path — refactored or not — that would leak across tenants.

import { getDB } from './supabase.js';
import { resolvePublicArtifact } from './public-links.js';

// Refuse a read with no resolved tenant. Used by tenantRead and callable
// directly by any read site that wants the guard without the query builder.
export function assertTenant(ctx, where = 'read') {
  if (!ctx || !ctx.tenantId || !ctx.userId) {
    throw new Error(`data-access: ${where} refused — no resolved tenant context (need ctx.tenantId + ctx.userId)`);
  }
}

// A tenant-scoped SELECT query builder. Always filtered by tenant_id + user_id.
// On the shared-MCP surface (ctx.visibilityFilter === 'sharable') it additionally
// restricts to visibility='sharable'. Returns a Supabase query builder so callers
// can chain .eq/.in/.order/.limit and await it.
export function tenantRead(ctx, table, columns = '*') {
  assertTenant(ctx, `tenantRead(${table})`);
  let q = getDB()
    .from(table)
    .select(columns)
    .eq('tenant_id', ctx.tenantId)
    .eq('user_id', ctx.userId);
  if (ctx.visibilityFilter === 'sharable') {
    q = q.eq('visibility', 'sharable');
  }
  return q;
}

// The single authorized tenantless read. Thin re-export so call sites import the
// public read from the same gateway as the tenant read, making the two-mode
// contract explicit. Returns a sanitized artifact payload or null (-> 404).
export async function publicArtifactRead(slug) {
  return resolvePublicArtifact(slug);
}
