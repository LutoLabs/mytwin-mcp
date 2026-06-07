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
import { RECON_CONFIG, autoThreshold, writeAllowed } from './config.js';
import { executeDecision, enqueueReview, ACTION_BY_REL } from './executor.js';

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
          fragment: { text: fragmentText, type: item.type, created_at: item.created_at },
        });
      } catch (err) {
        console.error('[reconcile] classify failed for candidate', cand.id, err?.message);
        continue;
      }
      // Guard: a valid ELABORATION must have a general<->specific direction. If
      // the classifier returns ELABORATION with direction 'n/a' (siblings that
      // merely share a theme), downgrade to DISTINCT so it can never create a
      // spurious 'elaborates' link. Defense in depth behind the prompt rule.
      let rel = cls.relationship;
      if (rel === 'ELABORATION' && (!cls.direction || cls.direction === 'n/a')) {
        rel = 'DISTINCT';
        cls.rationale = `[downgraded from ELABORATION — no general/specific direction] ${cls.rationale || ''}`;
      }
      const wouldAuto = (cls.confidence ?? 0) >= autoThreshold(rel);

      // Decide the action and (when live) actually perform it. The soak keeps
      // logging in every branch. Four cases:
      //   shadow                      -> record the would-be action, write nothing
      //   live + auto + write allowed -> execute, capture reverse_token
      //   live + auto + NOT allowed   -> record would-be action, write nothing
      //                                  (relationship not yet enabled in rollout)
      //   live + escalate             -> enqueue a review_items row for the user
      let action = wouldAuto ? (ACTION_BY_REL[rel] || 'none') : 'escalate';
      let reverseToken = null;

      if (!shadow) {
        if (wouldAuto && writeAllowed(rel)) {
          try {
            const res = await executeDecision({
              tenantId, userId, relationship: rel, direction: cls.direction,
              incomingItemId: itemId, candidateItemId: cand.id,
            });
            action = res.action; reverseToken = res.reverseToken;
          } catch (err) {
            // Fail-safe: a bad write never aborts the batch — downgrade to escalate.
            console.error('[reconcile] execute failed, escalating:', cand.id, err?.message);
            action = 'escalate';
            try { reverseToken = await enqueueReview({ tenantId, userId, incomingItemId: itemId, proposal: mkProposal(cand, rel, cls) }); } catch {}
          }
        } else if (action === 'escalate') {
          try { reverseToken = await enqueueReview({ tenantId, userId, incomingItemId: itemId, proposal: mkProposal(cand, rel, cls) }); }
          catch (err) { console.error('[reconcile] enqueueReview failed:', err?.message); }
        }
        // else: live + auto + not-yet-enabled -> would-be action recorded, no write.
      }

      decisions.push(mkDecision({
        tenantId, userId, itemId, candidate: cand,
        rel, confidence: cls.confidence, direction: cls.direction,
        rationale: cls.rationale, action, auto: wouldAuto, shadow, reverseToken,
      }));
    }
  }

  if (decisions.length) {
    const { error } = await db.from('reconciliation_decisions').insert(decisions);
    if (error) { console.error('[reconcile] decision log insert failed:', error.message); return { error: error.message }; }
  }
  return { itemId, decided: decisions.length, candidates: candidates.length, shadow };
}

function mkDecision({ tenantId, userId, itemId, candidate, rel, confidence, direction, rationale, action, auto, shadow, reverseToken }) {
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
    reverse_token:     reverseToken || null,   // null in shadow / no-op; describes how to undo a live write
  };
}

// Compact proposal payload stored on a review_items row for the batched confirm UI.
function mkProposal(candidate, rel, cls) {
  return {
    candidate_item_id: candidate ? candidate.id : null,
    candidate_title:   candidate ? (candidate.title || '') : '',
    relationship:      rel,
    action:            ACTION_BY_REL[rel] || 'none',
    confidence:        cls?.confidence ?? null,
    direction:         cls?.direction || 'n/a',
    rationale:         (cls?.rationale || '').slice(0, 300),
  };
}
