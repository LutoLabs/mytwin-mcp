// Rebuild the golden eval set from REAL prod shadow decisions, so the eval
// reflects messy reality (an ELABORATION-saturated corpus) instead of clean
// hand-written cases.
//
//   node scripts/recon-eval-rebuild.mjs <tenantId> [--judge]
//
// What it does (read-only on prod; writes only a local candidate file):
//   1. Pulls every shadow decision for the tenant that has a candidate item.
//   2. Hydrates both bodies (candidate = "item", incoming = "fragment").
//   3. Flags ELABORATION over-link suspects with a structural heuristic
//      (two same-level claim siblings linked as elaboration).
//   4. With --judge: runs an INDEPENDENT, ELABORATION-skeptical second-opinion
//      pass (a different prompt from the production classifier — NOT circular)
//      to estimate ELABORATION link-precision and surface disagreements.
//   5. Writes scripts/recon-eval-set.candidate.json — every case carries the
//      shadow prediction, the heuristic flag, the (optional) judge opinion, and
//      an expected_any slot PRE-FILLED with a proposal but marked needs_label:true.
//
// The classifier's own output is NEVER taken as gold. A human confirms each
// expected_any before this becomes the golden set (then: mv ...candidate.json
// scripts/recon-eval-set.json after review).

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const raw of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const l = raw.trim(); if (!l || l.startsWith('#')) continue;
  const eq = l.indexOf('='); if (eq < 1) continue;
  const k = l.slice(0, eq).trim(); let v = l.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (v) process.env[k] = v;
}

const tenantId = process.argv[2];
const useJudge = process.argv.includes('--judge');
if (!tenantId) { console.error('usage: node scripts/recon-eval-rebuild.mjs <tenantId> [--judge]'); process.exit(2); }

const { getDB } = await import('/Users/piotrkurzepa/mytwin/lib/supabase.js');
const db = getDB();

// Layer taxonomy (mirrors the classifier's LAYER RULE).
const CLAIM  = new Set(['principle', 'position', 'method', 'idea', 'knowledge', 'skill', 'template', 'voice']);
const SYNTH  = new Set(['theme', 'region', 'overview', 'synthesis', 'concept']);
const SOURCE = new Set(['resource', 'reference', 'source', 'document', 'url']);
const layer = t => CLAIM.has(t) ? 'claim' : SYNTH.has(t) ? 'synth' : SOURCE.has(t) ? 'source' : 'other';

// ── Pull decisions with a candidate (one (item, fragment) pair each) ──────────
const { data: decisions, error } = await db.from('reconciliation_decisions')
  .select('id, relationship, action, confidence, direction, rationale, incoming_item_id, candidate_item_id, created_at')
  .eq('tenant_id', tenantId).eq('shadow', true)
  .not('candidate_item_id', 'is', null)
  .order('created_at', { ascending: false });
if (error) { console.error('query failed:', error.message); process.exit(1); }
if (!decisions?.length) { console.error('no shadow decisions with candidates for this tenant'); process.exit(1); }

// Hydrate item bodies.
const ids = [...new Set(decisions.flatMap(d => [d.incoming_item_id, d.candidate_item_id]).filter(Boolean))];
const byId = new Map();
for (let i = 0; i < ids.length; i += 400) {
  const { data: items } = await db.from('knowledge').select('id, type, title, content, status').in('id', ids.slice(i, i + 400));
  for (const it of items || []) byId.set(it.id, it);
}

// ── Optional independent judge (ELABORATION skeptic) ──────────────────────────
let judge = null;
if (useJudge) {
  const { callFastJson } = await import('/Users/piotrkurzepa/mytwin/lib/anthropic.js');
  const JSYS = 'You are a strict reviewer of knowledge-graph links. A link should exist ONLY when one item ' +
    'is genuinely a specific instance/example of the OTHER\'s general principle or theme (a clear general->specific ' +
    'direction). Two items at the SAME level that merely share a topic must NOT be linked — that is over-linking, ' +
    'which clutters the graph. Judge the underlying ideas, not shared words.';
  const JSCHEMA = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['true_elaboration', 'over_link', 'distinct'] },
      confidence: { type: 'number' },
      why: { type: 'string' },
    },
    required: ['verdict', 'confidence', 'why'], additionalProperties: false,
  };
  judge = async (item, frag) => {
    const msg = [
      `ITEM A (type ${item.type}): ${item.title}\n${(item.content || '').slice(0, 700)}`,
      `ITEM B (type ${frag.type}): ${frag.title}\n${(frag.content || '').slice(0, 700)}`,
      '',
      'Is B a specific instance of A (or A of B) — a TRUE elaboration with a clear general->specific direction?',
      'Or are they two same-level siblings sharing only a theme (OVER-LINK)? Or unrelated (DISTINCT)?',
    ].join('\n');
    try { const { data } = await callFastJson({ system: JSYS, messages: [{ role: 'user', content: msg }], schema: JSCHEMA, maxTokens: 200 }); return data; }
    catch (e) { return { verdict: 'error', confidence: 0, why: (e.message || '').slice(0, 80) }; }
  };
}

// ── Build cases ───────────────────────────────────────────────────────────────
const cases = [];
let elabTotal = 0, elabSuspect = 0, judgeTrue = 0, judgeOverlink = 0, judgeOther = 0, judgeDisagree = 0;

for (const d of decisions) {
  const item = byId.get(d.candidate_item_id);   // existing
  const frag = byId.get(d.incoming_item_id);     // incoming fragment
  if (!item || !frag) continue;

  const sameType   = item.type === frag.type;
  const bothClaim  = layer(item.type) === 'claim' && layer(frag.type) === 'claim';
  const overlinkSuspect = d.relationship === 'ELABORATION' && sameType && bothClaim; // two same-level siblings

  if (d.relationship === 'ELABORATION') { elabTotal++; if (overlinkSuspect) elabSuspect++; }

  let judgeOpinion = null;
  if (useJudge && d.relationship === 'ELABORATION') {
    judgeOpinion = await judge(item, frag);
    if (judgeOpinion.verdict === 'true_elaboration') judgeTrue++;
    else if (judgeOpinion.verdict === 'over_link')   judgeOverlink++;
    else                                              judgeOther++;
    // disagreement: production said ELABORATION (link) but judge says it should not be a link
    if (judgeOpinion.verdict !== 'true_elaboration') judgeDisagree++;
  }

  cases.push({
    name: `prod-${d.id.slice(0, 8)}`,
    source_decision_id: d.id,
    shadow_pred: d.relationship,
    shadow_action: d.action,
    shadow_confidence: d.confidence,
    shadow_direction: d.direction,
    layers: `${item.type}(${layer(item.type)}) <- ${frag.type}(${layer(frag.type)})`,
    overlink_suspect: overlinkSuspect,
    ...(judgeOpinion ? { judge: judgeOpinion } : {}),
    item: { type: item.type, title: item.title || '', content: (item.content || '').slice(0, 1200), status: item.status },
    fragment: { type: frag.type, text: (frag.content || '').slice(0, 1200) },
    // PROPOSED label — a starting point for the human, NOT ground truth.
    expected_any: [d.relationship],
    needs_label: true,
  });
}

const outPath = resolve(process.cwd(), 'scripts/recon-eval-set.candidate.json');
const out = {
  description: 'CANDIDATE eval set rebuilt from real prod shadow decisions. Every case is needs_label:true — ' +
    'a human must confirm/correct expected_any before this replaces recon-eval-set.json. expected_any is PRE-FILLED ' +
    'with the shadow prediction (the classifier\'s own call) as a starting point only; do not treat it as gold. ' +
    'overlink_suspect flags two same-level claim siblings linked as ELABORATION (prime over-link candidates). ' +
    (useJudge ? 'judge = an independent ELABORATION-skeptical second opinion (advisory).' : 'Re-run with --judge for an independent second opinion.'),
  rebuilt_from_tenant: tenantId.slice(0, 8),
  total_cases: cases.length,
  cases,
};
writeFileSync(outPath, JSON.stringify(out, null, 2));

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n── Eval rebuild — tenant ${tenantId.slice(0, 8)} ──\n`);
console.log(`cases written: ${cases.length}  ->  ${outPath}`);
const dist = {};
for (const c of cases) dist[c.shadow_pred] = (dist[c.shadow_pred] || 0) + 1;
console.log('shadow-pred distribution:', dist);
console.log(`\nELABORATION cases: ${elabTotal}`);
console.log(`  structural over-link suspects (same-level claim siblings): ${elabSuspect}  (${elabTotal ? Math.round(100 * elabSuspect / elabTotal) : 0}%)`);
if (useJudge && elabTotal) {
  console.log(`\nINDEPENDENT JUDGE (advisory — confirm by hand):`);
  console.log(`  true_elaboration: ${judgeTrue}   over_link: ${judgeOverlink}   distinct/other: ${judgeOther}`);
  const linkPrecision = elabTotal ? judgeTrue / elabTotal : null;
  console.log(`  estimated ELABORATION link-precision: ${linkPrecision == null ? '—' : linkPrecision.toFixed(2)}  (true_elaboration / all ELABORATION links)`);
  console.log(`  production<->judge disagreements (link the judge would NOT draw): ${judgeDisagree}`);
}
console.log(`\nNext: hand-confirm expected_any in the candidate file (focus the over-link suspects${useJudge ? ' + judge disagreements' : ''}),`);
console.log(`then \`mv scripts/recon-eval-set.candidate.json scripts/recon-eval-set.json\` and run \`node scripts/recon-eval.mjs\`.\n`);
process.exit(0);
