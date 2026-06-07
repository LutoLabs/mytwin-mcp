# Reconciliation Phase 3 — built, gated, NOT live

Throwaway handoff doc (do not commit). Phase 3 auto-action writes + reversible
undo are built and verified, but `shadowMode` is still `true`, so nothing writes.
Flipping that one flag is yours, and you should not flip it until the rebuilt
eval is hand-confirmed (see below).

## The one flag

`lib/reconciliation/config.js` → `RECON_CONFIG.shadowMode`. While `true`, every
decision is logged and NOTHING writes (pure soak, unchanged from Phase 2).
Flipping it to `false` is the single master switch that turns auto-actions on.

It does NOT turn everything on at once. A subordinate `writeEnabled` map sequences
the rollout by destructiveness. With `shadowMode:false`, only relationships set
`true` in `writeEnabled` actually write; the rest still escalate or wait. Current
defaults (verified): the master flip activates exactly DUPLICATE + DISTINCT.

```
writeEnabled: { DUPLICATE: true, DISTINCT: true,
                REFINEMENT: false, ELABORATION: false,
                SUPERSEDE: false, CONTRADICTION: false }
```

`writeAllowed(rel)` fails closed: shadowMode off AND the bit on AND the relationship
has a real auto-action. SUPERSEDE is double-pinned (supersedeAlwaysEscalate) and
CONTRADICTION triple-pinned (Infinity threshold) — they stay escalate-only even
if someone flips their bit.

### Rollout sequence (as specified)
1. Flip `shadowMode:false` → DUPLICATE + DISTINCT begin writing (dedupe / no-op, trivially reversible).
2. Flip `writeEnabled.REFINEMENT:true` only after REFINEMENT precision is proven on the rebuilt eval (it rewrites a body).
3. Flip `writeEnabled.ELABORATION:true` only after LINK-PRECISION clears the gate (see finding below).
4. SUPERSEDE + CONTRADICTION stay escalate-only.

## What writes, and how each is reversible

Executor: `lib/reconciliation/executor.js`. Every action returns a `reverse_token`
(stored on the decision row, migration 025 — no new DDL). Nothing is ever hard-deleted.

| Rel | action | effect | undo |
|---|---|---|---|
| DUPLICATE | attach | incoming → status='merged', merged_into=candidate, + merged_into link | restore status, drop link |
| REFINEMENT | version | candidate body := incoming (snapshot+bump via updateKnowledge), incoming merged | restore prior body, restore incoming |
| SUPERSEDE | supersede | candidate → status='superseded', superseded_by=incoming, + supersedes link | restore status, drop link |
| ELABORATION | link | directed `elaborates` link (specific→general) | drop link |
| CONTRADICTION / low-conf | escalate | review_items row (batched confirm queue) | expire the review row |

`reverseDecision({ decisionId, tenantId })` is idempotent (no token → no-op;
already reverted → no-op) and tenant-scoped (cannot undo another tenant's decision).

Undo surfaces: `api/twin/reconciliation-undo.js` (POST `{decision_id}` or
`{incoming_item_id}`) and `scripts/recon-undo.mjs` (`decision|item|last`).
No vercel.json change needed — the route uses default maxDuration (stays under the 50-function cap).

The soak keeps running underneath in every branch: decisions are still logged
when live, so `scripts/recon-stats.mjs` / `api/twin/reconciliation-stats.js` keep working.

## Verification done

`scripts/_recon-verify.mjs` (already removed) ran 26 assertions against a throwaway
tenant: every action applied the expected state change, `reverseDecision` restored
the exact prior state, and a second undo was a no-op. All passed. Account torn down.

## The eval rebuild + the finding that matters

The clean hand-written golden set (`scripts/recon-eval-set.json`) scores ELABORATION
precision 1.00 — but it does NOT reflect reality. The real prod shadow corpus is
ELABORATION-saturated: of 81 shadow decisions, 69 (85%) are ELABORATION, every one
of which would become a hypergraph edge. The false-merge risk you worried about
barely exists yet (1 merge-like decision in the whole corpus); the real risk is
OVER-LINKING.

`scripts/recon-eval-rebuild.mjs <tenantId> [--judge]` rebuilt the set from those
real decisions → `scripts/recon-eval-set.candidate.json` (81 cases, every one
`needs_label:true`). It flags structural over-link suspects (same-level claim
siblings linked as elaboration: 10/69, 14%) and, with `--judge`, runs an
INDEPENDENT ELABORATION-skeptical second opinion (a different prompt from the
production classifier — not circular).

**Independent-judge estimate: ELABORATION link-precision ≈ 0.80** (55/69 true;
the judge would refuse 14 of 69 links). That is BELOW the 0.90 gate now enforced
in `scripts/recon-eval.mjs`. So: ELABORATION writes stay disabled — correctly.

This estimate is advisory. The golden set is ground truth only once a human confirms it.

## YOUR step before any flip: hand-label

1. Open `scripts/recon-eval-set.candidate.json`. Each case has both bodies, the
   shadow prediction, the `overlink_suspect` flag, and the judge opinion.
2. Confirm/correct `expected_any` per case. Focus the over-link suspects and the
   14 production↔judge disagreements — that is where the real labels diverge from
   the classifier's own call. Do NOT just accept the pre-filled prediction.
3. `mv scripts/recon-eval-set.candidate.json scripts/recon-eval-set.json`.
4. `node scripts/recon-eval.mjs` → read the ELABORATION link-precision gate line.
   - If it clears 0.90 on the hand-labeled set, ELABORATION writes may be enabled.
   - If not (the 0.80 estimate suggests it won't yet), the classifier prompt needs
     tightening against over-linking before ELABORATION is turned on.

## State

- `shadowMode` is still `true`. Nothing has written. The soak is intact.
- No migration needed or applied (the data model from 025 already covers Phase 3).
- No commit made, no deploy. HEAD was moved by another session, not by this work.
- Files changed by Phase 3:
  - M `lib/reconciliation/config.js`, `lib/reconciliation/engine.js`, `scripts/recon-eval.mjs`
  - new `lib/reconciliation/executor.js`, `api/twin/reconciliation-undo.js`,
    `scripts/recon-undo.mjs`, `scripts/recon-eval-rebuild.mjs`,
    `scripts/recon-eval-set.candidate.json` (working artifact — label then rename, don't commit as-is)
- Unrelated: `lib/anthropic.js` carries this session's earlier TWIN_MODEL → opus-4-8 change; `schema/rls-policies-draft.sql` is another session's, untouched.
