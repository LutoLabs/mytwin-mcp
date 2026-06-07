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

  // ── Phase 3: per-relationship write enablement (rollout by destructiveness) ──
  // SUBORDINATE to shadowMode: while shadowMode is true NOTHING writes, whatever
  // this map says. When shadowMode is flipped to false (the single master switch),
  // only the relationships set true here actually write; the rest still escalate.
  // So the master flip activates exactly the safe-first set below, and you widen
  // the rollout by flipping individual bits as each relationship's precision is
  // proven on the rebuilt eval:
  //   DUPLICATE + DISTINCT  — enabled first (dedup / no-op, trivially reversible)
  //   REFINEMENT            — enable only after its precision is proven on the new eval (rewrites a body)
  //   ELABORATION           — enable only after LINK-PRECISION is proven (every link is a hypergraph edge; over-linking degrades the graph)
  //   SUPERSEDE             — escalate-only (also pinned by supersedeAlwaysEscalate)
  //   CONTRADICTION         — escalate-only (also pinned by the Infinity threshold)
  writeEnabled: {
    DUPLICATE:     true,
    DISTINCT:      true,
    REFINEMENT:    false,
    ELABORATION:   false,
    SUPERSEDE:     false,
    CONTRADICTION: false,
  },

  // ── Stage 5: recompile debounce ────────────────────────────────────────────
  // Reuses the existing concept stale-mark + debounced recompileStaleJob; this
  // is the per-concept coalescing window so a burst of fragments → one recompile.
  recompileDebounceMinutes: 10,

  // ── Mode ───────────────────────────────────────────────────────────────────
  // THE single master switch. While true: log every decision, take NO write
  // action (pure soak). Phase 3 keeps this true until the rebuilt eval is trusted;
  // flipping it to false is the one action that turns auto-actions on, and it
  // activates exactly the writeEnabled set above (DUPLICATE + DISTINCT first).
  shadowMode: true,
};

// Whether an auto-action for `relationship` may actually WRITE right now.
// Fails closed: requires shadowMode off AND the per-relationship bit on AND the
// relationship to have a real auto-action (never SUPERSEDE/CONTRADICTION, which
// are pinned escalate-only by autoThreshold). The soak keeps logging regardless.
export function writeAllowed(relationship) {
  if (RECON_CONFIG.shadowMode) return false;                 // master switch wins
  if (relationship === 'CONTRADICTION') return false;        // escalate-only, always
  if (relationship === 'SUPERSEDE' && RECON_CONFIG.supersedeAlwaysEscalate) return false;
  return RECON_CONFIG.writeEnabled?.[relationship] === true;
}

// Resolve the auto-action threshold for a relationship, honouring the
// always-escalate override for SUPERSEDE and the never-auto rule for CONTRADICTION.
export function autoThreshold(relationship) {
  if (relationship === 'CONTRADICTION') return Infinity;            // always escalate
  if (relationship === 'SUPERSEDE' && RECON_CONFIG.supersedeAlwaysEscalate) return Infinity;
  return RECON_CONFIG.thresholds[relationship] ?? Infinity;
}
