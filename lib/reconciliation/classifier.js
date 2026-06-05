// Reconciliation Stage 3 — the relationship classifier (the core).
//
// Judges the relationship of a NEW fragment to an EXISTING item: semantic, not
// lexical (it must call "first cohort gets the best models" and "Piotr covers
// the model cost for cohort one" the same decision despite zero shared words).
//
// Reuses the existing Anthropic fast-JSON client (Haiku) with schema-enforced
// output — no new LLM plumbing. Prompt is the brief's starting point; tune it
// against the eval harness, never by editing thresholds here.

import { callFastJson } from '../anthropic.js';

const SYSTEM =
  'You decide the relationship between a NEW fragment of someone\'s thinking and an ' +
  'EXISTING item already in their knowledge base. Be strict and semantic — judge the ' +
  'underlying claim, not shared words.';

const SCHEMA = {
  type: 'object',
  properties: {
    relationship: { type: 'string', enum: ['DUPLICATE', 'REFINEMENT', 'SUPERSEDE', 'CONTRADICTION', 'ELABORATION', 'DISTINCT'] },
    confidence:   { type: 'number' },
    direction:    { type: 'string', enum: ['fragment_more_general', 'item_more_general', 'n/a'] },
    rationale:    { type: 'string' },
  },
  required: ['relationship', 'confidence', 'direction', 'rationale'],
  additionalProperties: false,
};

function buildUserMessage(item, fragment) {
  return [
    'EXISTING ITEM',
    `type: ${item.type || ''}`,
    `title: ${item.title || ''}`,
    `body: ${(item.content || item.body || '').slice(0, 1500)}`,
    `last updated: ${item.updated_at || item.created_at || ''}`,
    '',
    'NEW FRAGMENT',
    `type: ${fragment.type || 'unknown'}`,
    `captured: ${fragment.created_at || ''}`,
    `text: ${(fragment.text || '').slice(0, 1500)}`,
    '',
    'LAYER RULE (apply first, it overrides the rest): the store has three layers —',
    'CLAIMS (principle, position, method, idea, knowledge), SYNTHESES (a theme/region/',
    'overview page that compiles many claims), and SOURCES (a raw reference/resource/source).',
    'A synthesis or a source is NEVER the SAME CLAIM as anything, so it can never be',
    'DUPLICATE, REFINEMENT, or SUPERSEDE. If one item is a synthesis/theme and the other a',
    'specific claim under it -> ELABORATION. If one is a source and the other a claim drawn',
    'from it -> ELABORATION (the source is the general container). A source vs a synthesis, or',
    'two unrelated layers -> DISTINCT. Only two CLAIMS can DUPLICATE/REFINE/SUPERSEDE each other.',
    '',
    'Choose exactly one relationship:',
    '- DUPLICATE: same claim, the new fragment adds nothing.',
    '- REFINEMENT: same claim, but the new fragment sharpens it or adds detail/nuance.',
    '- SUPERSEDE: the new fragment replaces the existing one; the existing is now wrong or outdated.',
    '- CONTRADICTION: they conflict and cannot both be true at the same time.',
    '- ELABORATION: one is a specific instance/example of the other\'s general principle.',
    '- DISTINCT: not about the same thing.',
    '',
    'Decide by working through these questions IN ORDER; take the first that applies:',
    '',
    '1. Are they about the same thing at all? If not — different subjects, or you would have',
    '   to invent a bridging idea to connect them — answer DISTINCT.',
    '',
    '2. Do they make the SAME core claim (they AGREE about the same point)? If yes:',
    '   - the fragment adds NO new information -> DUPLICATE.',
    '   - the fragment sharpens, quantifies, extends, or adds a rule/caveat/mechanism behind',
    '     that same claim, AND the existing item still HOLDS TRUE -> REFINEMENT. (A mechanism,',
    '     cause, or detail OF the same claim is REFINEMENT, not a separate instance. Changing',
    '     HOW an idea is applied while the original still stands is REFINEMENT, not SUPERSEDE.)',
    '',
    '3. Do they CONFLICT (cannot both be true)? Then:',
    '   - if the fragment EXPLICITLY corrects/replaces the old ("correction", "actually", "this',
    '     replaces", "was wrong"), OR states a fact that CHANGED over time ("used to be X, now',
    '     Y") -> SUPERSEDE. An explicit correction signal is DECISIVE — do not downgrade it.',
    '   - otherwise — a bare conflicting assertion, however confident -> CONTRADICTION (the',
    '     user decides). A confident tone alone is NOT a correction signal.',
    '',
    '4. Otherwise they share a topic but neither agree nor conflict. If one is, on its face,',
    '   the broad principle/theme/category and the other a standalone specific instance of THAT',
    '   SAME one (a clear general->specific direction) -> ELABORATION (set direction). Two items',
    '   at the SAME level — two methods, two positions, two ideas merely sharing a topic — are',
    '   NOT ELABORATION; answer DISTINCT.',
    '',
    'Tie-breaker, only when you genuinely cannot choose: a false merge corrupts the store, a',
    'missed merge is recoverable — prefer DISTINCT over ELABORATION, REFINEMENT over SUPERSEDE,',
    'CONTRADICTION over SUPERSEDE. (This never overrides an explicit correction signal in 3.)',
    '',
    'direction indicates which is the more general/older one (matters for SUPERSEDE and ELABORATION):',
    'use "item_more_general" when the existing item is the broad principle and the fragment a specific case;',
    '"fragment_more_general" for the reverse; "n/a" otherwise.',
    '',
    'Return one sentence of rationale.',
  ].join('\n');
}

// Classify one (fragment, candidate-item) pair → { relationship, confidence, direction, rationale }.
export async function classifyRelationship({ item, fragment }) {
  const { data } = await callFastJson({
    system: SYSTEM,
    messages: [{ role: 'user', content: buildUserMessage(item, fragment) }],
    schema: SCHEMA,
    maxTokens: 300,
  });
  return data;
}
