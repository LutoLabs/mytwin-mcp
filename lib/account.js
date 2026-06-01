// Account deletion — GDPR-compliant, irreversible.
//
// What happens:
//   1. Pinecone: delete the tenant's namespace (drops all vectors).
//   2. Supabase: delete the tenant row. ON DELETE CASCADE wired in the
//      tenants migration cascades through users → knowledge / schema_types /
//      sources / mcp_tokens / magic_tokens. The audit_log table has NO foreign
//      key on user_id, so the deletion-event records survive.
//   3. Audit event is written before AND after — so we have both intent and
//      outcome on record even if the Supabase delete partially fails.
//
// What we do NOT do:
//   * Log any of the deleted content. Audit records are { user_id, tenant_id,
//     event_type, outcome } — never the knowledge/messages/etc.
//   * Cascade-delete audit history. That's the legal-hold trail.

import { getDB } from './supabase.js';
import { getNamespace } from './pinecone.js';
import { logAudit } from './audit.js';

// Phase 2 hardening (S-G): before a user is deleted, protect the org workspaces
// they belong to. workspaces.owner_id and knowledge.user_id are both ON DELETE
// CASCADE, so without this a departing owner would take the whole workspace down
// and any contributor would take their contributions with them. We:
//   1. transfer ownership of workspaces they own to a successor (earliest admin,
//      else earliest member); a sole-owner workspace is torn down cleanly,
//   2. reassign their contributed org items to the surviving owner so the items
//      persist (org content survives a member leaving).
// The asymmetric ratchet is unaffected: nothing moves into a personal tenant.
async function handleWorkspacesOnUserDeletion(db, userId) {
  const { data: memberships } = await db
    .from('workspace_memberships')
    .select('workspaces!inner(id, owner_id, tenant_id, type)')
    .eq('user_id', userId);

  for (const m of memberships || []) {
    const ws = m.workspaces;
    if (!ws || ws.type !== 'organisational') continue;

    let survivingOwnerId = ws.owner_id;

    if (ws.owner_id === userId) {
      const { data: others } = await db.from('workspace_memberships')
        .select('user_id, role, joined_at').eq('workspace_id', ws.id).neq('user_id', userId)
        .order('joined_at', { ascending: true });
      const admins = (others || []).filter(o => o.role === 'admin');
      const successor = admins[0] || (others || [])[0] || null;
      if (!successor) {
        // Sole member: tear the workspace down with its namespace + tenant.
        try { await getNamespace(ws.tenant_id).deleteAll(); } catch {}
        await db.from('tenants').delete().eq('id', ws.tenant_id);
        continue;
      }
      await db.from('workspaces').update({ owner_id: successor.user_id }).eq('id', ws.id);
      await db.from('workspace_memberships').update({ role: 'owner' }).eq('workspace_id', ws.id).eq('user_id', successor.user_id);
      survivingOwnerId = successor.user_id;
    }

    // Preserve this user's contributions so the cascade does not take them.
    await db.from('knowledge')
      .update({ user_id: survivingOwnerId })
      .eq('workspace_id', ws.id).eq('user_id', userId);
  }
}

export async function deleteAccount({ userId }) {
  const db = getDB();

  // Resolve tenant_id for this user (also confirms the user exists)
  const { data: user, error: userErr } = await db
    .from('users')
    .select('id, tenant_id')
    .eq('id', userId)
    .maybeSingle();
  if (userErr || !user) throw new Error('User not found');
  const tenantId = user.tenant_id;

  // Audit: started — before any destructive op so we have proof of intent
  logAudit({ userId, tenantId, eventType: 'account_deletion_started' });

  // Pinecone — best effort. If it fails, we still proceed with the DB delete;
  // orphan vectors in a deleted-tenant namespace are harmless (no row to
  // join against) and a future cleanup pass can drop them.
  let pineconeDeleted = false;
  let pineconeError   = null;
  try {
    await getNamespace(tenantId).deleteAll();
    pineconeDeleted = true;
  } catch (err) {
    pineconeError = err?.message || String(err);
    console.error('[delete-account] Pinecone deleteAll failed:', pineconeError);
  }

  // Phase 2 (S-G): hand off org workspaces and preserve contributed items before
  // the cascade takes this user. Best-effort; never block the deletion itself.
  try { await handleWorkspacesOnUserDeletion(db, userId); }
  catch (e) { console.error('[delete-account] workspace handoff failed:', e?.message); }

  // Supabase — cascade through tenants → users → everything else (except audit_log).
  const { error: delErr } = await db.from('tenants').delete().eq('id', tenantId);
  if (delErr) {
    logAudit({ userId, tenantId, eventType: 'account_deletion_completed', success: false, errorType: 'SupabaseDeleteFailed', errorMsg: delErr.message, context: { pinecone_deleted: pineconeDeleted } });
    throw new Error(`Supabase delete failed: ${delErr.message}`);
  }

  // Audit: completed
  logAudit({
    userId,
    tenantId,
    eventType: 'account_deletion_completed',
    success:   true,
    context:   { pinecone_deleted: pineconeDeleted, pinecone_error: pineconeError },
  });

  return { tenantId, pineconeDeleted, pineconeError };
}
