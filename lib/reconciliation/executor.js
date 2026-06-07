// Reconciliation Phase 3 — the write executor + reversible undo.
//
// Every auto-action is performed HERE and returns a `reverse_token`: a small
// jsonb descriptor with the exact before-state needed to undo it. The token is
// stored on the reconciliation_decisions row, so any applied action can be
// reversed later with no separate ledger. Undo is idempotent (a second reverse
// is a no-op) and we mark `reverted:true` inside the token rather than adding a
// column (keeps Phase 3 DDL-free — the data model from migration 025 suffices).
//
// Reversibility is structural, not best-effort: we NEVER hard-delete a row. A
// DUPLICATE/REFINEMENT folds the loser to status='merged' (recoverable), a
// SUPERSEDE flips status='superseded' (recoverable), an ELABORATION adds a row
// to item_links (deletable), an escalate adds a review_items row (expirable).
// knowledge_versions preserves the prior body for REFINEMENT undo.
//
// Nothing here decides WHETHER to write — config.writeAllowed() gates that, and
// the engine only calls executeDecision when a write is permitted.

import { getDB } from '../supabase.js';
import { updateKnowledge } from '../../tools/management.js';

// Relationship → the action label recorded on the decision row.
export const ACTION_BY_REL = {
  DUPLICATE:     'attach',
  REFINEMENT:    'version',
  SUPERSEDE:     'supersede',
  ELABORATION:   'link',
  CONTRADICTION: 'escalate',
  DISTINCT:      'none',
};

// Read a knowledge row's mutable lineage/body fields (tenant-scoped).
async function readItem(db, tenantId, id, cols = 'id, title, content, status, merged_into, superseded_by, version_number') {
  const { data } = await db.from('knowledge').select(cols).eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  return data || null;
}

// Insert a typed link, tolerating the (from,to,kind) unique constraint.
async function addLink(db, { tenantId, from, to, kind }) {
  const { data, error } = await db.from('item_links')
    .insert({ tenant_id: tenantId, from_item_id: from, to_item_id: to, kind, created_by: 'ai' })
    .select('id').maybeSingle();
  if (error) {
    if (error.code === '23505') return { id: null, existed: true };   // already linked — fine
    throw new Error(`item_links insert failed: ${error.message}`);
  }
  return { id: data?.id || null, existed: false };
}

async function removeLink(db, { tenantId, from, to, kind, id }) {
  let q = db.from('item_links').delete().eq('tenant_id', tenantId);
  if (id) q = q.eq('id', id);
  else    q = q.eq('from_item_id', from).eq('to_item_id', to).eq('kind', kind);
  await q;
}

async function setLineage(db, tenantId, id, fields) {
  await db.from('knowledge').update(fields).eq('id', id).eq('tenant_id', tenantId);
}

// ── Execute one auto-action ─────────────────────────────────────────────────
// Returns { action, reverseToken }. Pure write; the caller logs the decision.
// userId/tenantId scope every mutation. Throws on hard failure (caller downgrades
// to escalate so a single bad write never aborts the batch or affects ingestion).
export async function executeDecision({ tenantId, userId, relationship, direction, incomingItemId, candidateItemId }) {
  const db = getDB();
  const ctx = { userId, tenantId };

  switch (relationship) {
    // DISTINCT — the incoming item simply stands on its own. No write.
    case 'DISTINCT':
      return { action: ACTION_BY_REL.DISTINCT, reverseToken: null };

    // DUPLICATE — dedupe: fold the incoming dup into the existing candidate.
    case 'DUPLICATE': {
      const prev = await readItem(db, tenantId, incomingItemId, 'status, merged_into');
      await setLineage(db, tenantId, incomingItemId, { status: 'merged', merged_into: candidateItemId });
      const link = await addLink(db, { tenantId, from: incomingItemId, to: candidateItemId, kind: 'merged_into' });
      return {
        action: 'attach',
        reverseToken: {
          kind: 'attach',
          incomingItemId, candidateItemId,
          prevStatus: prev?.status ?? 'active',
          prevMergedInto: prev?.merged_into ?? null,
          linkId: link.id, linkExisted: link.existed,
        },
      };
    }

    // REFINEMENT — fold the sharper incoming body INTO the candidate as a new
    // version (history preserved via knowledge_versions), then merge the dup away.
    // Deterministic on purpose: the candidate's new body IS the incoming text — no
    // LLM fabrication in an auto-write path. Fully reversible to the prior body.
    case 'REFINEMENT': {
      const before   = await readItem(db, tenantId, candidateItemId, 'title, content, version_number');
      const incoming = await readItem(db, tenantId, incomingItemId, 'title, content, status, merged_into');
      if (!before || !incoming) throw new Error('REFINEMENT: candidate or incoming item missing');
      // updateKnowledge snapshots the old body, bumps the version, and re-embeds.
      await updateKnowledge(ctx, { id: candidateItemId, content: incoming.content });
      await setLineage(db, tenantId, incomingItemId, { status: 'merged', merged_into: candidateItemId });
      const link = await addLink(db, { tenantId, from: incomingItemId, to: candidateItemId, kind: 'merged_into' });
      return {
        action: 'version',
        reverseToken: {
          kind: 'version',
          candidateItemId, incomingItemId,
          prevTitle: before.title ?? '', prevContent: before.content,
          incomingPrevStatus: incoming.status ?? 'active',
          incomingPrevMergedInto: incoming.merged_into ?? null,
          linkId: link.id, linkExisted: link.existed,
        },
      };
    }

    // SUPERSEDE — deprecate the old candidate, keep the new incoming as current.
    // Both rows persist (the outdated claim is retained, just flagged). Pinned
    // escalate-only by config, so this normally never runs; built for completeness.
    case 'SUPERSEDE': {
      const prev = await readItem(db, tenantId, candidateItemId, 'status, superseded_by');
      await setLineage(db, tenantId, candidateItemId, { status: 'superseded', superseded_by: incomingItemId });
      const link = await addLink(db, { tenantId, from: incomingItemId, to: candidateItemId, kind: 'supersedes' });
      return {
        action: 'supersede',
        reverseToken: {
          kind: 'supersede',
          candidateItemId, incomingItemId,
          prevStatus: prev?.status ?? 'active',
          prevSupersededBy: prev?.superseded_by ?? null,
          linkId: link.id, linkExisted: link.existed,
        },
      };
    }

    // ELABORATION — keep both items, add a directed 'elaborates' link (specific
    // -> general). Every such link becomes a hypergraph edge, so this is gated on
    // proven link-precision. direction picks which item is the general parent.
    case 'ELABORATION': {
      // 'elaborates' reads from(specific) -> to(general).
      let from = incomingItemId, to = candidateItemId;       // item_more_general: candidate is the parent
      if (direction === 'fragment_more_general') { from = candidateItemId; to = incomingItemId; }
      const link = await addLink(db, { tenantId, from, to, kind: 'elaborates' });
      return {
        action: 'link',
        reverseToken: { kind: 'link', from, to, linkKind: 'elaborates', linkId: link.id, linkExisted: link.existed },
      };
    }

    default:
      throw new Error(`executeDecision: unhandled relationship ${relationship}`);
  }
}

// ── Escalation — hand a decision to the user's review queue ──────────────────
// Used when live and the decision is not auto-writable (low confidence,
// CONTRADICTION, SUPERSEDE). Idempotent per incoming item: one pending row,
// proposals appended.
export async function enqueueReview({ tenantId, userId, incomingItemId, proposal }) {
  const db = getDB();
  const { data: existing } = await db.from('review_items')
    .select('id, proposals').eq('tenant_id', tenantId).eq('user_id', userId)
    .eq('incoming_item_id', incomingItemId).eq('state', 'pending').maybeSingle();

  if (existing) {
    const proposals = Array.isArray(existing.proposals) ? existing.proposals : [];
    proposals.push(proposal);
    await db.from('review_items').update({ proposals }).eq('id', existing.id);
    return { kind: 'escalate', reviewId: existing.id, appended: true };
  }
  const { data: row } = await db.from('review_items')
    .insert({ tenant_id: tenantId, user_id: userId, incoming_item_id: incomingItemId, proposals: [proposal], state: 'pending' })
    .select('id').maybeSingle();
  return { kind: 'escalate', reviewId: row?.id || null, appended: false };
}

// ── Reverse one applied decision by id ───────────────────────────────────────
// Idempotent: no token -> nothing was written; already reverted -> no-op.
// Restores the exact before-state from the token, then marks it reverted.
export async function reverseDecision({ decisionId, tenantId = null }) {
  const db = getDB();
  // Tenant scoping: when tenantId is supplied (API path), a cross-tenant id
  // resolves to not-found — never reverse another tenant's decision.
  let q = db.from('reconciliation_decisions')
    .select('id, tenant_id, user_id, reverse_token').eq('id', decisionId);
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data: dec } = await q.maybeSingle();
  if (!dec) return { reversed: false, reason: 'decision-not-found' };

  const token = dec.reverse_token;
  if (!token || typeof token !== 'object') return { reversed: false, reason: 'no-op (nothing was written)' };
  if (token.reverted)                      return { reversed: false, reason: 'already-reverted' };

  const decTenantId = dec.tenant_id, ctx = { userId: dec.user_id, tenantId: dec.tenant_id };

  switch (token.kind) {
    case 'attach':
      await setLineage(db, decTenantId, token.incomingItemId, { status: token.prevStatus, merged_into: token.prevMergedInto });
      if (!token.linkExisted) await removeLink(db, { tenantId: decTenantId, from: token.incomingItemId, to: token.candidateItemId, kind: 'merged_into', id: token.linkId });
      break;

    case 'version':
      // Restore the candidate's prior body (re-snapshots + re-embeds via updateKnowledge).
      await updateKnowledge(ctx, { id: token.candidateItemId, title: token.prevTitle, content: token.prevContent });
      await setLineage(db, decTenantId, token.incomingItemId, { status: token.incomingPrevStatus, merged_into: token.incomingPrevMergedInto });
      if (!token.linkExisted) await removeLink(db, { tenantId: decTenantId, from: token.incomingItemId, to: token.candidateItemId, kind: 'merged_into', id: token.linkId });
      break;

    case 'supersede':
      await setLineage(db, decTenantId, token.candidateItemId, { status: token.prevStatus, superseded_by: token.prevSupersededBy });
      if (!token.linkExisted) await removeLink(db, { tenantId: decTenantId, from: token.incomingItemId, to: token.candidateItemId, kind: 'supersedes', id: token.linkId });
      break;

    case 'link':
      if (!token.linkExisted) await removeLink(db, { tenantId: decTenantId, from: token.from, to: token.to, kind: token.linkKind, id: token.linkId });
      break;

    case 'escalate':
      if (token.reviewId) await db.from('review_items').update({ state: 'expired' }).eq('id', token.reviewId);
      break;

    default:
      return { reversed: false, reason: `unknown token kind ${token.kind}` };
  }

  await db.from('reconciliation_decisions')
    .update({ reverse_token: { ...token, reverted: true } })
    .eq('id', decisionId);
  return { reversed: true, kind: token.kind };
}
