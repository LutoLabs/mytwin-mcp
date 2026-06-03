// lib/concept-context.js
//
// Fetches the user's compiled concept pages and returns the subset that are
// relevant to the current user message, formatted as an XML block ready to
// prepend to the Sonnet context window in turn.js.
//
// Flow:
//   1. Load up to MAX_CONCEPTS concept pages from the DB (fast — DB query).
//   2. If there are no pages yet: return '' immediately (zero overhead).
//   3. If there are ≤ SMALL_THRESHOLD pages: include all of them (skip Haiku).
//   4. Otherwise: one Haiku call to pick the relevant subset (≤ MAX_INCLUDE).
//   5. Format and return a <concept_pages>…</concept_pages> block.
//
// All errors are non-fatal — the caller wraps this in .catch(() => '').

import { getDB }       from './supabase.js';
import { callFastJson } from './anthropic.js';

const MAX_CONCEPTS     = 30;   // max fetched from DB
const SMALL_THRESHOLD  = 4;    // skip Haiku when we have ≤ this many
const MAX_INCLUDE      = 5;    // max concepts injected into context

// ── DB fetch ─────────────────────────────────────────────────────────────────

async function fetchConceptPages(ctx) {
  const { userId, tenantId } = ctx;
  const db = getDB();
  const { data, error } = await db
    .from('concept_pages')
    .select('id, flavour, title, summary, is_stale')
    .eq('user_id',   userId)
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })
    .limit(MAX_CONCEPTS);

  if (error) throw new Error(error.message);
  return data || [];
}

// ── Haiku relevance filter ────────────────────────────────────────────────────

const RELEVANCE_SCHEMA = {
  type: 'object',
  properties: {
    relevant_ids: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required:             ['relevant_ids'],
  additionalProperties: false,
};

async function filterRelevant(concepts, userMessage) {
  const list = concepts
    .map(c => `${c.id}: [${c.flavour}] ${c.title}${c.summary ? ` — ${c.summary}` : ''}`)
    .join('\n');

  const { data } = await callFastJson({
    system: [
      'You are a relevance filter for a personal knowledge base.',
      'Given a user message and a list of synthesised concept pages,',
      'return the IDs of concepts that are directly relevant to the user\'s',
      'query or creative task. Return an empty array if none apply.',
      'Be selective: include only concepts that would genuinely help the response.',
    ].join(' '),
    messages: [{
      role:    'user',
      content: `User message:\n${userMessage}\n\nConcept pages:\n${list}\n\nReturn relevant IDs (max ${MAX_INCLUDE}).`,
    }],
    schema:    RELEVANCE_SCHEMA,
    maxTokens: 300,
  });

  const ids = new Set((data.relevant_ids || []).slice(0, MAX_INCLUDE));
  return concepts.filter(c => ids.has(c.id));
}

// ── Format block ──────────────────────────────────────────────────────────────

function formatConceptBlock(concepts) {
  if (!concepts.length) return '';
  const body = concepts
    .map(c => {
      // Flag stale pages so the model knows new material has landed since the
      // page was last compiled and weights it accordingly.
      const staleNote = c.is_stale ? ' (updating — new material added since last compile)' : '';
      return `[${c.flavour.toUpperCase()} PATTERN] ${c.title}${staleNote}\n${c.summary || ''}`;
    })
    .join('\n\n');
  return `<concept_pages>\n${body}\n</concept_pages>\n\n`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns an XML block of relevant concept pages, or '' if none apply.
 * Always resolves (never rejects) — call site wraps in .catch(() => '').
 *
 * @param {object}        ctx         — { userId, tenantId }
 * @param {string}        userMessage — the message to check relevance against
 * @param {string[]|null} pinnedIds   — optional IDs selected by the user in the
 *                                      context panel; these are always included,
 *                                      remaining slots filled by relevance filter
 * @returns {Promise<string>}
 */
export async function getConceptContext(ctx, userMessage, pinnedIds = null) {
  const concepts = await fetchConceptPages(ctx);
  if (!concepts.length) return '';

  // ── Pinned IDs path ───────────────────────────────────────────────────────
  // When the user has explicitly selected concept pages in the context panel,
  // include those first. Fill remaining slots (up to MAX_INCLUDE) with
  // relevance-filtered pages from the unpinned pool.
  if (Array.isArray(pinnedIds) && pinnedIds.length > 0) {
    const pinnedSet = new Set(pinnedIds);
    const pinned    = concepts.filter(c => pinnedSet.has(c.id)).slice(0, MAX_INCLUDE);

    if (pinned.length >= MAX_INCLUDE) {
      // All slots consumed by the user's selections — skip relevance filter.
      return formatConceptBlock(pinned);
    }

    const unpinned  = concepts.filter(c => !pinnedSet.has(c.id));
    const remaining = MAX_INCLUDE - pinned.length;

    let extra = [];
    if (unpinned.length > 0) {
      const filtered = unpinned.length <= SMALL_THRESHOLD
        ? unpinned
        : await filterRelevant(unpinned, userMessage);
      extra = filtered.slice(0, remaining);
    }

    return formatConceptBlock([...pinned, ...extra]);
  }

  // ── Default path (no pinned IDs) ──────────────────────────────────────────
  const candidates = concepts.length <= SMALL_THRESHOLD
    ? concepts                                    // small set → skip Haiku
    : await filterRelevant(concepts, userMessage); // larger set → filter

  return formatConceptBlock(candidates.slice(0, MAX_INCLUDE));
}
