// Reconciliation engine — orchestrates stages 1–4 for one freshly-stored item.
//
// Phase 2 runs this in SHADOW MODE: it embeds the item, retrieves candidates,
// classifies each, decides what action it WOULD take, and logs every decision
// to reconciliation_decisions — but performs NO write to knowledge/links. This
// proves the system is additive and produces the data to tune thresholds before
// any auto-action is enabled (Phase 3).
//
// Post-insert model: the "fragment" is the just-stored item; decisions reference
// incoming_item_id. Idempotent (skips items already reconciled). Fail-safe — any
// error here never affects ingestion (this runs as a separate async job).

import { getDB }            from '../supabase.js';
import { embed }            from '../embed.js';
import { getRawCandidates } from './candidates.js';
import { classifyRelationship } from './classifier.js';
import { RECON_CONFIG, autoThreshold } from './config.js';

// Relationship → the action it WOULD take. In shadow mode this is recorded, not executed.
const ACTION_BY_REL = {
  DUPLICATE:     'attach',     // attach as source, no version bump
  REFINEMENT:    'version',    // merge into item, version bump
  SUPERSEDE:     'supersede',  // deprecate old → new current
  ELABORATION:   'link',       // keep apart, typed link
  CONTRADICTION: 'escalate',   // always to the user
  DISTINCT:      'none',       // no action vs this candidate
};

export async function reconcileItem({ tenantId, userId, itemId, shadow = RECON_CONFIG.shadowMode }) {
  const db = getDB();

  const { data: item } = await db.from('knowledge')
    .select('id, type, title, content, source_type, created_at, status')
    .eq('id', itemId).eq('tenant_id', tenantId).maybeSingle();
  if (!item) return { skipped: 'item-not-found' };

  // Skip workspace-contributed copies — they were already reconciled in the
  // contributor's own tenant; reconciling the copy is double work.
  if (item.source_type === 'contributed') return { skipped: 'contributed-copy' };

  // Idempotency: never double-log for the same incoming item.
  const { count: existing } = await db.from('reconciliation_decisions')
    .select('id', { count: 'exact', head: true }).eq('incoming_item_id', itemId);
  if (existing && existing > 0) return { skipped: 'already-reconciled' };

  const fragmentText = [item.title, item.content].filter(Boolean).join('\n');
  if (!fragmentText.trim()) return { skipped: 'empty' };

  const embedding  = await embed(fragmentText);
  const candidates = await getRawCandidates({ tenantId, embedding, excludeItemId: itemId });

  // Stage 2 floor: nothing clears S_min → DISTINCT (would create new), skip the LLM.
  const above = candidates.filter(c => c.score >= RECON_CONFIG.similarityFloor);

  const decisions = [];
  if (!above.length) {
    decisions.push(mkDecision({
      tenantId, userId, itemId, candidate: null,
      rel: 'DISTINCT', confidence: 1, direction: 'n/a',
      rationale: candidates.length ? 'best candidate below similarity floor' : 'no candidates',
      action: 'create', auto: true, shadow,
    }));
  } else {
    for (const cand of above) {
      let cls;
      try {
        cls = await classifyRelationship({
          item: cand,
          fragment: { text: fragmentText, created_at: item.created_at },
        });
      } catch (err) {
        console.error('[reconcile] classify failed for candidate', cand.id, err?.message);
        continue;
      }
      const rel      = cls.relationship;
      const wouldAuto = (cls.confidence ?? 0) >= autoThreshold(rel);
      const action    = wouldAuto ? (ACTION_BY_REL[rel] || 'none') : 'escalate';
      decisions.push(mkDecision({
        tenantId, userId, itemId, candidate: cand,
        rel, confidence: cls.confidence, direction: cls.direction,
        rationale: cls.rationale, action, auto: wouldAuto, shadow,
      }));
    }
  }

  if (decisions.length) {
    const { error } = await db.from('reconciliation_decisions').insert(decisions);
    if (error) { console.error('[reconcile] decision log insert failed:', error.message); return { error: error.message }; }
  }
  return { itemId, decided: decisions.length, candidates: candidates.length, shadow };
}

function mkDecision({ tenantId, userId, itemId, candidate, rel, confidence, direction, rationale, action, auto, shadow }) {
  return {
    tenant_id:         tenantId,
    user_id:           userId,
    incoming_item_id:  itemId,
    candidate_item_id: candidate ? candidate.id : null,
    relationship:      rel,
    confidence:        typeof confidence === 'number' ? confidence : null,
    direction:         direction || 'n/a',
    rationale:         (rationale || '').slice(0, 500),
    action,
    auto:              Boolean(auto),
    actor:             'ai',
    shadow:            Boolean(shadow),
  };
}
