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
    `captured: ${fragment.created_at || ''}`,
    `text: ${(fragment.text || '').slice(0, 1500)}`,
    '',
    'Choose exactly one relationship:',
    '- DUPLICATE: same claim, the new fragment adds nothing.',
    '- REFINEMENT: same claim, but the new fragment sharpens it or adds detail/nuance.',
    '- SUPERSEDE: the new fragment replaces the existing one; the existing is now wrong or outdated.',
    '- CONTRADICTION: they conflict and cannot both be true at the same time.',
    '- ELABORATION: one is a specific instance/example of the other\'s general principle.',
    '- DISTINCT: not about the same thing.',
    '',
    'How to choose the close calls (read carefully):',
    '- ELABORATION requires that one item is, ON ITS FACE, a general principle and the',
    '  other is UNMISTAKABLY a concrete instance of THAT SAME principle. Do NOT invent or',
    '  infer a bridging principle to connect two items. If you have to construct a general',
    '  rule that neither item actually states in order to link them, they are DISTINCT.',
    '  Same-subject extra detail/mechanism/number is REFINEMENT, not ELABORATION.',
    '- DUPLICATE vs REFINEMENT: same claim, same scope. DUPLICATE if the fragment adds no',
    '  new information; REFINEMENT if it sharpens, quantifies, or explains the same claim.',
    '- SUPERSEDE vs CONTRADICTION — apply this test. Choose SUPERSEDE ONLY if EITHER:',
    '    (a) the new fragment explicitly corrects or replaces the old (references it, or says',
    '        "correction", "actually", "this replaces", "was wrong"), OR',
    '    (b) it describes a fact that CHANGED over time ("used to be X, now Y").',
    '  If the new fragment merely ASSERTS a conflicting fact, number, or plan — even',
    '  confidently or with a rationale — without correcting the old or describing a',
    '  change-over-time, that is CONTRADICTION. When two claims disagree and you cannot tell',
    '  which is currently true, choose CONTRADICTION so the user decides. A confident tone is',
    '  NOT a correction signal.',
    '- When genuinely unsure, prefer DISTINCT. A false merge corrupts the store; a missed',
    '  merge is recoverable.',
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
