// Reconciliation telemetry (§15).
//
// Aggregates the shadow (and later, live) decision log so a soak can be reviewed
// before Phase 3 auto-actions are trusted. Read-only over reconciliation_decisions.
//
// Surfaced via api/twin/reconciliation-stats.js (tenant-scoped) and scripts/recon-stats.mjs.

import { getDB } from '../supabase.js';

const REL_ORDER  = ['DUPLICATE', 'REFINEMENT', 'SUPERSEDE', 'CONTRADICTION', 'ELABORATION', 'DISTINCT', 'NONE'];
const ACT_ORDER  = ['create', 'attach', 'version', 'supersede', 'link', 'escalate', 'none'];

export async function reconciliationStats({ tenantId, sinceDays = 30, limit = 5000 }) {
  const db = getDB();
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();

  const { data: rows, error } = await db
    .from('reconciliation_decisions')
    .select('relationship, action, auto, shadow, confidence, incoming_item_id, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const byRelationship = Object.fromEntries(REL_ORDER.map(r => [r, 0]));
  const byAction       = Object.fromEntries(ACT_ORDER.map(a => [a, 0]));
  const fragments      = new Set();
  let confSum = 0, confN = 0, autoCount = 0, escalateCount = 0, shadowCount = 0, liveCount = 0;

  for (const d of rows || []) {
    if (d.relationship in byRelationship) byRelationship[d.relationship]++;
    if (d.action in byAction) byAction[d.action]++;
    if (d.incoming_item_id) fragments.add(d.incoming_item_id);
    if (typeof d.confidence === 'number') { confSum += d.confidence; confN++; }
    if (d.auto) autoCount++;
    if (d.action === 'escalate') escalateCount++;
    if (d.shadow) shadowCount++; else liveCount++;
  }

  const total = (rows || []).length;
  const fragCount = fragments.size;
  // A "would-merge" is any safe fold-in or supersede the system would have taken.
  const wouldMerge = byAction.attach + byAction.version + byAction.supersede + byAction.link;

  return {
    window_days:        sinceDays,
    decisions:          total,
    fragments_reconciled: fragCount,
    avg_candidates_per_fragment: fragCount ? +(total / fragCount).toFixed(2) : 0,
    by_relationship:    byRelationship,
    by_action:          byAction,
    auto_vs_escalate:   { would_auto: autoCount, would_escalate: escalateCount },
    would_merge_signals: wouldMerge,           // dedup pressure: how much the store would compound
    avg_confidence:     confN ? +(confSum / confN).toFixed(3) : null,
    mode:               { shadow: shadowCount, live: liveCount },
  };
}
