// Reconciliation system — tunable configuration (Phase 1 foundations).
//
// Thresholds and tuning knobs live HERE, never hardcoded in the pipeline, so
// they can be tuned against the eval set without touching pipeline code.
//
// Guiding bias (state it loudly): a FALSE MERGE is worse than a false duplicate.
// Merging two genuinely different ideas corrupts the store; failing to merge two
// similar ones merely leaves a near-dupe. So risky relationships (SUPERSEDE,
// REFINEMENT) require MORE confidence than safe ones, and when torn the
// classifier should prefer ELABORATION/DISTINCT.
//
// Nothing here is wired into the write path yet — this is inert config that the
// Phase 2 shadow-mode engine will read.

export const RELATIONSHIPS = [
  'DUPLICATE', 'REFINEMENT', 'SUPERSEDE', 'CONTRADICTION', 'ELABORATION', 'DISTINCT',
];

export const RECON_CONFIG = {
  // ── Stage 2: candidate retrieval ───────────────────────────────────────────
  candidateTopK:   8,      // K nearest items to consider per fragment
  similarityFloor: 0.55,   // S_min — if the best candidate is below this, short-circuit
                           // to DISTINCT and skip the (expensive) LLM classifier.

  // ── Stage 4: per-relationship auto-action thresholds ───────────────────────
  // Confidence at/above the threshold → auto-act. Below → escalate.
  thresholds: {
    DUPLICATE:     0.80,   // safe (attach, no version bump)
    REFINEMENT:    0.85,   // riskier (rewrites the item body)
    ELABORATION:   0.80,   // safe (keep both, add a link)
    DISTINCT:      0.70,   // below → create new anyway (always safe)
    SUPERSEDE:     0.92,   // deprecates existing knowledge — see supersedeAlwaysEscalate
    CONTRADICTION: 1.01,   // unreachable on purpose → ALWAYS escalate
  },

  // SUPERSEDE deprecates existing knowledge, so Phase 1 default is to NEVER
  // auto-act on it — always hand to the user — until the eval set is trusted.
  // Flip to false (and rely on the 0.92 threshold) only behind explicit sign-off.
  supersedeAlwaysEscalate: true,

  // ── Stage 5: recompile debounce ────────────────────────────────────────────
  // Reuses the existing concept stale-mark + debounced recompileStaleJob; this
  // is the per-concept coalescing window so a burst of fragments → one recompile.
  recompileDebounceMinutes: 10,

  // ── Mode ───────────────────────────────────────────────────────────────────
  // Phase 2 runs in shadow: log every decision, take NO write action. Proves the
  // system is additive before any auto-action is enabled in Phase 3.
  shadowMode: true,
};

// Resolve the auto-action threshold for a relationship, honouring the
// always-escalate override for SUPERSEDE and the never-auto rule for CONTRADICTION.
export function autoThreshold(relationship) {
  if (relationship === 'CONTRADICTION') return Infinity;            // always escalate
  if (relationship === 'SUPERSEDE' && RECON_CONFIG.supersedeAlwaysEscalate) return Infinity;
  return RECON_CONFIG.thresholds[relationship] ?? Infinity;
}
