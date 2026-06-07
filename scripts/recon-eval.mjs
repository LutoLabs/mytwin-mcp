// Reconciliation classifier eval harness.
//
// Runs the relationship classifier over the golden set (scripts/recon-eval-set.json)
// and reports per-relationship precision/recall + a pass/fail. Pure classifier —
// no DB writes, no reconciliation side effects. Re-run after any prompt/model
// change to catch regressions; gate merges on SUPERSEDE/CONTRADICTION not dropping.
//
//   node scripts/recon-eval.mjs

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env.local (Anthropic key) — shell may export an empty ANTHROPIC_API_KEY, so overwrite.
for (const raw of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const l = raw.trim(); if (!l || l.startsWith('#')) continue;
  const eq = l.indexOf('='); if (eq < 1) continue;
  const k = l.slice(0, eq).trim(); let v = l.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (v) process.env[k] = v;
}

const { classifyRelationship } = await import('/Users/piotrkurzepa/mytwin/lib/reconciliation/classifier.js');

const set = JSON.parse(readFileSync(resolve(process.cwd(), 'scripts/recon-eval-set.json'), 'utf8'));
const LABELS = ['DUPLICATE', 'REFINEMENT', 'SUPERSEDE', 'CONTRADICTION', 'ELABORATION', 'DISTINCT'];

// Per-label tallies for precision/recall. We score against the FIRST expected
// label as the "gold" for recall, but accept any expected_any label as correct.
const tp = {}, fp = {}, fn = {};
for (const L of LABELS) { tp[L] = 0; fp[L] = 0; fn[L] = 0; }

let pass = 0, fail = 0;
const rows = [];

for (const c of set.cases) {
  let pred;
  try {
    const r = await classifyRelationship({ item: c.item, fragment: c.fragment });
    pred = r.relationship;
    var conf = r.confidence, rat = r.rationale;
  } catch (e) {
    pred = 'ERROR:' + (e.message || '').slice(0, 40);
  }
  const ok = c.expected_any.includes(pred);
  const gold = c.expected_any[0];
  if (ok) { pass++; tp[pred] = (tp[pred] || 0) + 1; }
  else {
    fail++;
    if (LABELS.includes(pred)) fp[pred] = (fp[pred] || 0) + 1;
    fn[gold] = (fn[gold] || 0) + 1;
  }
  rows.push({ name: c.name, expected: c.expected_any.join('|'), pred, conf, ok, rat });
}

console.log('\n── Reconciliation classifier eval ──\n');
for (const r of rows) {
  console.log(`${r.ok ? '✓' : '✗'}  ${r.name.padEnd(36)} expected ${r.expected.padEnd(22)} got ${String(r.pred).padEnd(14)} ${r.conf != null ? '('+r.conf+')' : ''}`);
  if (!r.ok) console.log(`     rationale: ${r.rat || ''}`);
}

console.log(`\nOverall: ${pass}/${pass + fail} correct\n`);
console.log('Per-relationship precision / recall (over this set):');
for (const L of LABELS) {
  const p = tp[L] + fp[L] ? (tp[L] / (tp[L] + fp[L])) : null;
  const rc = tp[L] + fn[L] ? (tp[L] / (tp[L] + fn[L])) : null;
  if (tp[L] + fp[L] + fn[L] === 0) continue;
  console.log(`  ${L.padEnd(14)} precision ${p == null ? '—' : p.toFixed(2)}   recall ${rc == null ? '—' : rc.toFixed(2)}   (tp ${tp[L]} fp ${fp[L]} fn ${fn[L]})`);
}

// Gate: SUPERSEDE and CONTRADICTION must be correct (the high-stakes labels).
const gateCases = rows.filter(r => /SUPERSEDE|CONTRADICTION/.test(r.expected));
const gateFail = gateCases.filter(r => !r.ok);
console.log(`\nHigh-stakes gate (SUPERSEDE/CONTRADICTION): ${gateCases.length - gateFail.length}/${gateCases.length} correct`);

// ── ELABORATION link-precision gate ──────────────────────────────────────────
// Every ELABORATION becomes a hypergraph edge, and over-linking degrades the
// graph UX, so ELABORATION writes stay disabled until link-precision clears a
// high bar on the rebuilt eval. Precision here = of everything the classifier
// CALLED ELABORATION, how much truly was (tp / (tp+fp)) — i.e. how few spurious
// links it would draw. This is the number to clear before flipping
// writeEnabled.ELABORATION true in lib/reconciliation/config.js.
const ELAB_TARGET = 0.90;
const elabTp = tp['ELABORATION'], elabFp = fp['ELABORATION'];
const elabPrecision = (elabTp + elabFp) ? elabTp / (elabTp + elabFp) : null;
const elabRecall    = (elabTp + fn['ELABORATION']) ? elabTp / (elabTp + fn['ELABORATION']) : null;
console.log(`\nELABORATION link-precision gate (target ≥ ${ELAB_TARGET.toFixed(2)}):`);
console.log(`  precision ${elabPrecision == null ? '— (no ELABORATION cases)' : elabPrecision.toFixed(2)}   recall ${elabRecall == null ? '—' : elabRecall.toFixed(2)}   (tp ${elabTp} fp ${elabFp} fn ${fn['ELABORATION']})`);
const elabGatePass = elabPrecision != null && elabPrecision >= ELAB_TARGET;
console.log(`  -> ELABORATION writes ${elabGatePass ? 'MAY be enabled (precision clears the bar)' : 'must stay DISABLED (precision below bar or unmeasured)'}`);

process.exit(fail === 0 ? 0 : 1);
