// Data-access for outbound connectors: the `connections` table (encrypted
// credentials + sync cursor) and the `connection_sources` native-id map.
//
// Every read/write is tenant-scoped — the service-role key bypasses Postgres
// RLS, so isolation is enforced HERE, exactly like lib/data-access.js. The one
// deliberate exception is getConnectionForWebhook(), which loads by id without a
// session (the webhook is unauthenticated and routed by ?c=<id>); it returns the
// row's tenant_id/user_id so all downstream work re-scopes to that tenant.

import { getDB } from './supabase.js';
import { encryptSecret, decryptSecret } from './connector-crypto.js';

// Columns safe to return to the browser — never the *_ciphertext fields.
const PUBLIC_COLS =
  'id, provider, auth_type, external_account_id, display_name, scopes, status, ' +
  'last_error, last_synced_at, created_at, updated_at, cursor';

// Shape a row for an API response: strip every secret, keep status/cursor.
export function toPublicConnection(row) {
  if (!row) return null;
  return {
    id:                  row.id,
    provider:            row.provider,
    auth_type:           row.auth_type,
    external_account_id: row.external_account_id || null,
    display_name:        row.display_name || null,
    scopes:              row.scopes || null,
    status:              row.status,
    last_error:          row.last_error || null,
    last_synced_at:      row.last_synced_at || null,
    backfill_done:       !!(row.cursor && row.cursor.backfill_done),
    created_at:          row.created_at,
    updated_at:          row.updated_at,
  };
}

// ── connections CRUD ──────────────────────────────────────────────────────────

/**
 * Create or update a connection for (tenant, provider, account). Upserts on the
 * (tenant_id, provider, coalesce(external_account_id,'')) unique index so a
 * re-connect refreshes credentials in place rather than duplicating.
 *
 * Secrets are encrypted here; pass plaintext. Pass `undefined` to leave an
 * existing encrypted field untouched on update; pass null to clear it.
 */
export async function upsertConnection(ctx, {
  provider, authType,
  secret, refresh, webhookSecret,
  tokenExpiresAt, scopes, externalAccountId, displayName,
  cursor, status,
}) {
  const db = getDB();
  const row = {
    tenant_id:           ctx.tenantId,
    user_id:             ctx.userId,
    provider,
    auth_type:           authType,
    external_account_id: externalAccountId ?? null,
    display_name:        displayName ?? null,
    scopes:              scopes ?? null,
    token_expires_at:    tokenExpiresAt ?? null,
    status:              status ?? 'active',
    updated_at:          new Date().toISOString(),
  };
  if (secret !== undefined)        row.secret_ciphertext         = encryptSecret(secret);
  if (refresh !== undefined)       row.refresh_ciphertext        = encryptSecret(refresh);
  if (webhookSecret !== undefined) row.webhook_secret_ciphertext = encryptSecret(webhookSecret);
  if (cursor !== undefined)        row.cursor                    = cursor;

  const { data, error } = await db
    .from('connections')
    .upsert(row, { onConflict: 'tenant_id,provider,external_account_id' })
    .select('*')
    .single();
  if (error) {
    // Fall back to a manual find-then-update if the upsert's conflict target
    // can't be inferred (e.g. the COALESCE-based index name differs by env).
    const existing = await getConnectionByProvider(ctx, provider, externalAccountId);
    if (existing) {
      const { data: upd, error: uErr } = await db
        .from('connections').update(row)
        .eq('id', existing.id).eq('tenant_id', ctx.tenantId)
        .select('*').single();
      if (uErr) throw new Error(`connections.update: ${uErr.message}`);
      return upd;
    }
    const { data: ins, error: iErr } = await db
      .from('connections').insert(row).select('*').single();
    if (iErr) throw new Error(`connections.insert: ${iErr.message}`);
    return ins;
  }
  return data;
}

export async function listConnections(ctx) {
  const db = getDB();
  const { data, error } = await db
    .from('connections')
    .select(PUBLIC_COLS)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`connections.list: ${error.message}`);
  return data || [];
}

// Full row (incl. ciphertext) for server-side sync work. Tenant-scoped.
export async function getConnection(ctx, id) {
  const db = getDB();
  const { data, error } = await db
    .from('connections').select('*')
    .eq('id', id).eq('tenant_id', ctx.tenantId).maybeSingle();
  if (error) throw new Error(`connections.get: ${error.message}`);
  return data || null;
}

export async function getConnectionByProvider(ctx, provider, externalAccountId = null) {
  const db = getDB();
  let q = db.from('connections').select('*')
    .eq('tenant_id', ctx.tenantId).eq('provider', provider);
  if (externalAccountId) q = q.eq('external_account_id', externalAccountId);
  const { data, error } = await q.order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(`connections.getByProvider: ${error.message}`);
  return data || null;
}

// Unauthenticated load for the webhook path (routed by ?c=<id>). Returns the
// row including tenant_id/user_id so the caller re-scopes to that tenant.
export async function getConnectionForWebhook(id) {
  if (!id) return null;
  const db = getDB();
  const { data, error } = await db
    .from('connections').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`connections.getForWebhook: ${error.message}`);
  return data || null;
}

export async function deleteConnection(ctx, id) {
  const db = getDB();
  // connection_sources cascades on connection delete (FK on delete cascade), so
  // the native-id map is cleared too — ingestion for this connection stops.
  const { error } = await db
    .from('connections').delete().eq('id', id).eq('tenant_id', ctx.tenantId);
  if (error) throw new Error(`connections.delete: ${error.message}`);
  return true;
}

// ── credential access ─────────────────────────────────────────────────────────

export function decryptConnectionSecret(row)        { return decryptSecret(row?.secret_ciphertext); }
export function decryptConnectionRefresh(row)        { return decryptSecret(row?.refresh_ciphertext); }
export function decryptConnectionWebhookSecret(row)  { return decryptSecret(row?.webhook_secret_ciphertext); }

// ── sync state ────────────────────────────────────────────────────────────────

export async function updateConnectionCursor(tenantId, id, { cursor, lastSyncedAt, status, lastError }) {
  const db = getDB();
  const patch = { updated_at: new Date().toISOString() };
  if (cursor !== undefined)       patch.cursor         = cursor;
  if (lastSyncedAt !== undefined) patch.last_synced_at = lastSyncedAt;
  if (status !== undefined)       patch.status         = status;
  if (lastError !== undefined)    patch.last_error     = lastError;
  const { error } = await db
    .from('connections').update(patch).eq('id', id).eq('tenant_id', tenantId);
  if (error) throw new Error(`connections.updateCursor: ${error.message}`);
}

// ── connection_sources: the (provider, external_id) -> source_id map ────────────

export async function getMapping(tenantId, provider, externalId) {
  const db = getDB();
  const { data, error } = await db
    .from('connection_sources').select('*')
    .eq('tenant_id', tenantId).eq('provider', provider).eq('external_id', externalId)
    .maybeSingle();
  if (error) throw new Error(`connection_sources.get: ${error.message}`);
  return data || null;
}

export async function upsertMapping(ctx, { connectionId, provider, externalId, sourceId, contentHash, externalUpdatedAt }) {
  const db = getDB();
  const row = {
    tenant_id:           ctx.tenantId,
    connection_id:       connectionId,
    provider,
    external_id:         externalId,
    source_id:           sourceId ?? null,
    content_hash:        contentHash ?? null,
    external_updated_at: externalUpdatedAt ?? null,
    ingested_at:         new Date().toISOString(),
    updated_at:          new Date().toISOString(),
  };
  const { data, error } = await db
    .from('connection_sources')
    .upsert(row, { onConflict: 'tenant_id,provider,external_id' })
    .select('*').single();
  if (error) throw new Error(`connection_sources.upsert: ${error.message}`);
  return data;
}

// How many items this connection has ingested so far (for the UI count).
export async function countMappings(ctx, connectionId) {
  const db = getDB();
  const { count, error } = await db
    .from('connection_sources')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId).eq('connection_id', connectionId);
  if (error) return 0;
  return count || 0;
}
