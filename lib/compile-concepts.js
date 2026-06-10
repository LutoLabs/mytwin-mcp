// lib/compile-concepts.js
//
// Concept-page compilation pipeline.
//
// Runs in an Inngest background job (and on-demand via the compile endpoint).
// Does not block the user-facing response.
//
// Failure policy: every run records its outcome to background_log under
// 'concept-compile' (status 'completed' | 'failed' | 'skipped', with a meta
// summary). Fatal problems (fetch error, truncated clustering, all-pages-failed)
// THROW so the Inngest run is marked failed and retried — never a silent
// "still compiling" forever.
//
// Pipeline:
//   1. Fetch all knowledge rows for tenant
//   2. Cluster ALL items with Haiku — LLM assigns flavour (knowledge/skills) per cluster
//   3. For each cluster ≥ 2 items: compile a page with Sonnet (bounded concurrency)
//   4. Upsert into concept_pages (new or version++)

import Anthropic from '@anthropic-ai/sdk';
import { getDB } from './supabase.js';
import { writeBackgroundLog } from './background-log.js';
import { stripDashes, cleanTitle } from './text-clean.js';

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ── Clustering ────────────────────────────────────────────────────────────────
// The LLM now decides flavour (knowledge vs skills) from content, not from type.

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          concept:  { type: 'string', description: 'Short label for this concept cluster' },
          flavour:  { type: 'string', enum: ['knowledge', 'skills'] },
          item_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['concept', 'flavour', 'item_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['clusters'],
  additionalProperties: false,
};

const CLUSTER_SYSTEM = `You are organising a personal knowledge base into concept clusters.

Below are all stored items for this user (title and summary only).
Group them into concept clusters based on semantic meaning.

For each cluster, also decide:
- flavour: "knowledge" if the cluster is about how this person understands or views something
- flavour: "skills" if the cluster is about how this person creates, writes, or expresses something

Rules:
- Minimum 2 items per cluster
- Maximum 10 clusters total
- A cluster can contain both knowledge and skill items
- Items that do not fit any coherent cluster may be omitted`;

async function clusterItems(items) {
  if (items.length < 2) return [];

  const itemSummaries = items.map(i =>
    `id: ${i.id}\ntitle: ${i.title || '(no title)'}\nsummary: ${(i.content || '').slice(0, 200)}`
  ).join('\n\n');

  // max_tokens must comfortably exceed the JSON for ALL items. The previous
  // value (1200) truncated the response for larger twins — stop_reason came
  // back 'max_tokens', JSON.parse threw, and the whole run silently produced
  // zero clusters (the root cause of "still compiling" forever). 16000 is the
  // non-streaming ceiling for this model and covers ~550 items; beyond that we
  // detect truncation below and fail loudly rather than dropping everything.
  const resp = await client().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 16000,
    system: CLUSTER_SYSTEM,
    messages: [{ role: 'user', content: `Group these items into concept clusters:\n\n${itemSummaries}` }],
    output_config: { format: { type: 'json_schema', schema: CLUSTER_SCHEMA } },
  });

  if (resp.stop_reason === 'max_tokens') {
    throw new Error(
      `clustering truncated at max_tokens (${resp.usage?.output_tokens} output tokens for ${items.length} items) — raise max_tokens or reduce the item batch`,
    );
  }

  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`clustering returned invalid JSON (${err.message}); first 200 chars: ${text.slice(0, 200)}`);
  }

  let clusters = Array.isArray(parsed.clusters) ? parsed.clusters : [];
  // Honour the documented "max 10 clusters" cap — if the model overshoots,
  // keep the largest clusters so the synchronous compile stays inside budget.
  if (clusters.length > 10) {
    clusters = [...clusters]
      .sort((a, b) => (b.item_ids?.length || 0) - (a.item_ids?.length || 0))
      .slice(0, 10);
  }
  return clusters;
}

// ── Compilation ───────────────────────────────────────────────────────────────

// Body voice is person-aware: second person for a personal twin, the named
// subject for a representational or shared twin. The TITLE is always the bare
// concept as a plain noun phrase — the italic standfirst + "Compiled from N
// sources" carry the personal and provenance framing, so the title never needs
// a "How ... think about" wrapper or a name.
function bodyVoice(subject, perspective, examples) {
  if (perspective !== 'personal' && subject) {
    return `Write in the third person about ${subject}, using the name ("${subject} believes...", "${subject}'s pattern is...").`;
  }
  return `Write in second person (${examples}).`;
}

const TITLE_RULE = `title: the concept ITSELF as a plain noun phrase, written like a heading (sentence case, capitalise the first word). It is NOT a sentence and is NEVER prefixed with "How ... thinks about", "How they ...", or any name. Examples:
  proposal design -> "Proposal design"
  building MyAITwin / Luto -> "Building MyAITwin"
  voice, craft, and what it means to build -> "Voice, craft, and what it means to build"
  security for MyAITwin MCP -> "MyAITwin MCP security"`;

function thinkingSystem({ subject, perspective } = {}) {
  const who = (perspective !== 'personal' && subject) ? subject : 'this person';
  return `You are compiling a concept page for an AI twin.

Your job is to synthesise stored knowledge items into a concept page about how ${who} thinks.

Rules:
- ${bodyVoice(subject, perspective, '"You believe...", "Your approach is...", "You tend to..."')}
- Flowing prose, no headers. Use markdown lightly: **bold** for key claims, *italics* for emphasis.
- Do not invent. Do not generalise beyond what the items contain.
- Surface tensions, open questions, or evolution visible across the items if present.
- Be specific. Name the actual views, not vague descriptions of having views.
- Never use em dashes or en dashes. None, anywhere. Use a comma or a full stop.

Return valid JSON only, no explanation, no markdown fences:
{"title": "...", "summary": "...", "content": "..."}

${TITLE_RULE}
summary: One sentence capturing the core view (this becomes the standfirst).
content: The compiled page body (markdown prose, 200-500 words).`;
}

function craftSystem({ subject, perspective } = {}) {
  const who = (perspective !== 'personal' && subject) ? subject : 'this person';
  return `You are compiling a craft page for an AI twin.

Your job is to synthesise stored items into a concept page about how ${who} creates.

Rules:
- ${bodyVoice(subject, perspective, '"You open with...", "You never use...", "Your pattern is..."')}
- Flowing prose, no headers. Use markdown lightly: **bold** for definitive patterns, *italics* for examples.
- Do not invent. Pull patterns from what the items actually show.
- Include specific phrases, examples, or structural patterns from the items where illustrative.
- Cover: the voice and style principles, what is always done, what is never done.
- Never use em dashes or en dashes. None, anywhere. Use a comma or a full stop.

Return valid JSON only, no explanation, no markdown fences:
{"title": "...", "summary": "...", "content": "..."}

${TITLE_RULE}
summary: One sentence capturing the defining approach (this becomes the standfirst).
content: The compiled page body (markdown prose, 200-500 words).`;
}

const PAGE_SCHEMA = {
  type: 'object',
  properties: {
    title:   { type: 'string' },
    summary: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['title', 'summary', 'content'],
  additionalProperties: false,
};

// The twin owner's name + perspective, for the body voice. Perspective is
// 'personal' (second person) by default; a representational or shared twin would
// resolve to a named subject once that signal exists. The title is bare either way.
function displayNameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  const words = local.replace(/[._+-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
async function twinPerspective(db, userId) {
  try {
    const { data } = await db.from('users').select('email').eq('id', userId).maybeSingle();
    return { subject: data?.email ? displayNameFromEmail(data.email) : null, perspective: 'personal' };
  } catch {
    return { subject: null, perspective: 'personal' };
  }
}

// opts: { subject, perspective } — the twin owner's name + perspective
// ('personal' => second person; otherwise => third person about the subject).
export async function compilePage(items, flavour, opts = {}) {
  const itemsText = items.map(i =>
    `---\nTitle: ${i.title || '(no title)'}\nType: ${i.type}\nDate: ${i.created_at?.slice(0, 10) || '?'}\n\n${(i.content || '').slice(0, 2000)}`
  ).join('\n\n');

  const systemPrompt = (flavour === 'knowledge' ? thinkingSystem : craftSystem)(opts);

  // json_schema output guarantees well-formed JSON — the free-form prose body
  // used to break JSON.parse when it contained an unescaped quote or newline.
  //
  // Model: Haiku, not Sonnet. Concept pages are internal synthesis, not
  // user-facing chat, and page-compile OUTPUT tokens are the single largest line
  // on the Anthropic bill (up to 10 pages per full compile, ~2K output each).
  // Sonnet output is $15/M vs Haiku's $5/M, so this is a ~3x cut on the dominant
  // cost with no user-visible quality surface. The clustering pass above is
  // already on Haiku.
  const msg = await client().messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Items to compile:\n\n${itemsText}` }],
    output_config: { format: { type: 'json_schema', schema: PAGE_SCHEMA } },
  });

  if (msg.stop_reason === 'max_tokens') {
    throw new Error(`page compile truncated at max_tokens (${msg.usage?.output_tokens} output tokens)`);
  }

  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  try {
    return JSON.parse(text);
  } catch {
    // Tolerant fallback: strip any stray fences and parse the outermost object.
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    return JSON.parse(cleaned); // throw the original-style error if truly unparseable
  }
}

// ── Upsert ────────────────────────────────────────────────────────────────────

async function upsertConceptPage(db, { userId, tenantId, flavour, title, summary, content, sourceIds, visibility }) {
  // Find existing page with the most overlapping source_ids
  const { data: existing } = await db
    .from('concept_pages')
    .select('id, version, source_ids')
    .eq('tenant_id', tenantId)
    .eq('user_id',   userId)
    .eq('flavour',   flavour);

  let bestMatch = null;
  let bestOverlap = 0;
  for (const page of existing || []) {
    const overlap = (page.source_ids || []).filter(id => sourceIds.includes(id)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; bestMatch = page; }
  }

  if (bestMatch && bestOverlap >= 1) {
    // Update existing page — merge source_ids, bump version. A freshly compiled
    // page is by definition current, so clear any staleness flag here. Without
    // this, a successful full compile left pages flagged stale, which re-queued
    // them forever — the "stuck stale" symptom behind B6.
    const mergedIds = [...new Set([...bestMatch.source_ids, ...sourceIds])];
    await db
      .from('concept_pages')
      .update({
        title,
        summary,
        content,
        source_ids:  mergedIds,
        version:     bestMatch.version + 1,
        updated_at:  new Date().toISOString(),
        visibility,
        is_stale:    false,
        stale_since: null,
      })
      .eq('id', bestMatch.id);
  } else {
    // Insert new page — explicitly not stale.
    await db
      .from('concept_pages')
      .insert({
        tenant_id:   tenantId,
        user_id:     userId,
        flavour,
        title,
        summary,
        content,
        source_ids:  sourceIds,
        version:     1,
        visibility,
        is_stale:    false,
        stale_since: null,
      });
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

// Records the run outcome to background_log. Never throws — logging must not
// mask the real error the caller is about to surface.
async function logCompile(tenantId, status, meta) {
  try {
    await writeBackgroundLog(tenantId, 'concept-compile', status, meta);
  } catch (err) {
    console.error('[compile-concepts] log write failed:', err?.message);
  }
}

// Same idea for the stale-recompile job, under a DISTINCT job_name so its runs
// are visible on their own and never blend into the full-compile log. This is
// the job whose silent absence went unnoticed for a day; every run now writes a
// 'started' record and a terminal record, so a missing run is detectable.
async function logRecompile(tenantId, status, meta) {
  try {
    await writeBackgroundLog(tenantId, 'concept-recompile', status, meta);
  } catch (err) {
    console.error('[recompile-stale] log write failed:', err?.message);
  }
}

// Clusters are capped at 10, so a concurrency of 10 compiles them in a single
// wave — keeps wall-clock well inside the function budget for large twins.
const COMPILE_CONCURRENCY = 10;

// Stable, dependency-free key for a cluster's page, derived from its source item
// IDs (order-independent). Used as the Inngest step id so a retried full compile
// replays already-written pages from memoized state instead of regenerating —
// and re-paying for — them. FNV-1a 32-bit, 8 hex chars.
function pageStepKey(itemIds) {
  const joined = [...(itemIds || [])].sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// opts:
//   step — when invoked from an Inngest function, pass its `step` tool so the
//          clustering call and each page compile become memoized steps. A retry
//          then skips pages already written this run and re-attempts only the
//          page that failed, so one failing page never regenerates the others.
//          Omit (e.g. the on-demand endpoint) to run inline with bounded
//          concurrency and the original failure-isolating semantics.
//   mode — recorded in the background_log meta so spend audits can split full
//          compiles by trigger ('bootstrap' | 'on-demand' | ...).
export async function compileConceptsForTenant({ userId, tenantId, step = null, mode = 'unknown' }) {
  const db = getDB();
  const voice = await twinPerspective(db, userId);   // owner + perspective for the body voice

  const { data: items, error } = await db
    .from('knowledge')
    .select('id, type, title, content, tags, created_at, visibility')
    .eq('user_id',   userId)
    .eq('tenant_id', tenantId)
    // Canon (the Eleusis seed) is never compiled into a user's concept pages.
    // Redundant with system-tenant isolation, but keeps the wall explicit.
    .neq('provenance', 'canon');

  if (error) {
    await logCompile(tenantId, 'failed', { stage: 'fetch', mode, error: error.message });
    throw new Error(`[compile-concepts] fetch error: ${error.message}`);
  }
  if (!items?.length || items.length < 2) {
    await logCompile(tenantId, 'skipped', { reason: 'not_enough_items', mode, items: items?.length || 0 });
    return { clusters: 0, pagesWritten: 0, failures: 0, skipped: true };
  }

  // Single clustering pass over ALL items — LLM assigns flavour per cluster.
  // A clustering failure is fatal: with no clusters we would write zero pages,
  // which presents to the user as an eternal "still compiling". Surface it.
  let clusters;
  try {
    // Memoize the clustering call when running inside an Inngest step, so a
    // retry of a later page does not re-pay for (or re-shuffle) the clustering.
    clusters = step
      ? await step.run('cluster-concepts', () => clusterItems(items))
      : await clusterItems(items);
  } catch (err) {
    await logCompile(tenantId, 'failed', { stage: 'cluster', mode, items: items.length, error: err.message });
    throw new Error(`[compile-concepts] clustering failed: ${err.message}`);
  }

  // Build the work list — only clusters that resolve to ≥ 2 real items.
  const jobs = [];
  for (const cluster of clusters) {
    if (!Array.isArray(cluster.item_ids) || cluster.item_ids.length < 2) continue;
    const clusterRows = items.filter(i => cluster.item_ids.includes(i.id));
    if (clusterRows.length < 2) continue;
    const flavour = cluster.flavour === 'skills' ? 'skills' : 'knowledge'; // safe default
    jobs.push({ cluster, clusterRows, flavour });
  }

  if (jobs.length === 0) {
    await logCompile(tenantId, 'completed', { clusters: 0, pagesWritten: 0, failures: 0, mode });
    return { clusters: 0, pagesWritten: 0, failures: 0 };
  }

  let pagesWritten = 0;
  let failures = 0;

  // Shared per-page work: compile the prose, then upsert. Throws on an
  // empty/invalid page so the caller treats it as a failure.
  const writePage = async ({ cluster, clusterRows, flavour }) => {
    const page = await compilePage(clusterRows, flavour, voice);
    if (!page?.title || !page?.summary || !page?.content) {
      throw new Error(`empty page for cluster "${cluster.concept}"`);
    }
    // A concept page is sharable only when ALL its source items are sharable.
    // If any source is private the compiled page stays private too.
    const allShareable = clusterRows.every(r => r.visibility === 'sharable');
    await upsertConceptPage(db, {
      userId,
      tenantId,
      flavour,
      title:      cleanTitle(page.title),
      summary:    stripDashes(page.summary),
      content:    stripDashes(page.content),
      sourceIds:  clusterRows.map(r => r.id),
      visibility: allShareable ? 'sharable' : 'private',
    });
  };

  if (step) {
    // Idempotent path: each page is its own Inngest step keyed by its source set.
    // On a retry, pages whose steps already succeeded replay from memoized state
    // (no recompile, no tokens) and only the failed page re-runs — so one failing
    // page never regenerates the other nine. Sequential is fine: at most 10 fast
    // Haiku calls, well inside the function budget. A page that throws propagates
    // and Inngest retries the run (bounded by the function's `retries`).
    for (const job of jobs) {
      await step.run(`compile-page-${pageStepKey(job.cluster.item_ids)}`, async () => {
        await writePage(job);
        return { ok: true };
      });
      pagesWritten++;   // reached only when the step succeeded (fresh or memoized)
    }
  } else {
    // Inline path (on-demand endpoint): bounded concurrency, failures isolated so
    // one bad page doesn't sink the others. Fast enough to finish inside the 120s
    // function budget, gentle enough not to hammer the API all at once.
    for (let i = 0; i < jobs.length; i += COMPILE_CONCURRENCY) {
      const batch = jobs.slice(i, i + COMPILE_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(writePage));
      for (const r of results) {
        if (r.status === 'fulfilled') { pagesWritten++; }
        else { failures++; console.error('[compile-concepts] page compile failed:', r.reason?.message); }
      }
    }
  }

  const summary = { clusters: jobs.length, pagesWritten, failures, mode };

  // If every cluster failed to compile, the run did not succeed — fail loudly.
  // (Unreachable on the step path: a failing page throws rather than counting,
  // and an empty job list returned earlier.)
  if (pagesWritten === 0) {
    await logCompile(tenantId, 'failed', { stage: 'compile', ...summary });
    throw new Error(`[compile-concepts] all ${jobs.length} cluster compiles failed`);
  }

  // Memoize the success log too, so an internal step replay can't duplicate it.
  if (step) {
    await step.run('log-compile-complete', () => logCompile(tenantId, 'completed', summary));
  } else {
    await logCompile(tenantId, 'completed', summary);
  }
  return summary;
}

// ── Targeted staleness (the cost guardrail) ─────────────────────────────────────
//
// markStalePagesForItem: cheap, LLM-free. When one new item is added, flag only
// the concept pages whose topic (title + summary) overlaps the item's tags, type,
// or title keywords. Pages that do not match are never touched. This runs on the
// (background) write path; it does NOT recompile anything.
//
// recompileStalePages: the LLM-bearing pass. Runs ONLY over pages already flagged
// stale, expanding each page's source set with newly-matching items and rewriting
// it. Invoked from a debounced Inngest job, never inline on ingest. Idempotent:
// re-running after success is a no-op (no stale pages remain).

export async function markStalePagesForItem({ userId, tenantId, itemId }) {
  const db = getDB();

  const { data: item } = await db
    .from('knowledge')
    .select('type, title, tags, provenance')
    .eq('id', itemId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  // Canon items never mark a user's concept pages stale.
  if (!item || item.provenance === 'canon') return 0;

  // Term set from the new item: tags + type + title keywords (≥ 4 chars).
  const itemTerms = new Set(
    [
      ...(item.tags || []).map(t => String(t).toLowerCase()),
      String(item.type || '').toLowerCase(),
      ...String(item.title || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4),
    ].filter(Boolean),
  );
  if (!itemTerms.size) return 0;

  // Only titles + summaries — a cheap read, no page bodies.
  const { data: pages } = await db
    .from('concept_pages')
    .select('id, title, summary')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
  if (!pages?.length) return 0;

  const staleIds = pages
    .filter(p => {
      const pageText = `${p.title || ''} ${p.summary || ''}`.toLowerCase();
      return [...itemTerms].some(term => pageText.includes(term));
    })
    .map(p => p.id);

  if (!staleIds.length) return 0;

  const { error: updErr } = await db
    .from('concept_pages')
    .update({ is_stale: true, stale_since: new Date().toISOString() })
    .in('id', staleIds);
  // Surface a missing-column error so the caller can fall back to a full
  // compile in the window before migration 024 has been applied.
  if (updErr) throw new Error(`mark-stale update failed: ${updErr.message}`);

  return staleIds.length;
}

export async function recompileStalePages({ userId, tenantId }) {
  // Heartbeat: prove the job actually fired. If recompile-stale ever stops
  // running (e.g. an Inngest sync drift), the absence of these 'started' rows
  // is the signal — the job is no longer allowed to fail silently.
  await logRecompile(tenantId, 'started', { userId });

  try {
  const db = getDB();
  const voice = await twinPerspective(db, userId);

  const { data: stalePages } = await db
    .from('concept_pages')
    .select('id, flavour, title, summary, source_ids, version, visibility')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('is_stale', true);
  if (!stalePages?.length) {
    await logRecompile(tenantId, 'completed', { recompiled: 0, staleCount: 0, reason: 'no_stale_pages' });
    return { recompiled: 0, staleCount: 0 };
  }

  // Source of truth for expansion — all current items for this tenant.
  const { data: allItems } = await db
    .from('knowledge')
    .select('id, type, title, content, tags, created_at, visibility')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    // Canon (the Eleusis seed) is never a source for a user's concept pages.
    .neq('provenance', 'canon');
  if (!allItems?.length) {
    // Nothing to compile from — clear the flags so we don't loop.
    await db
      .from('concept_pages')
      .update({ is_stale: false, stale_since: null })
      .in('id', stalePages.map(p => p.id));
    await logRecompile(tenantId, 'completed', { recompiled: 0, staleCount: stalePages.length, reason: 'no_items' });
    return { recompiled: 0, staleCount: stalePages.length };
  }

  const allById = new Map(allItems.map(i => [i.id, i]));
  let recompiled = 0;
  let failures = 0;

  for (const page of stalePages) {
    try {
      const existingSet  = new Set(page.source_ids || []);
      const existingItems = (page.source_ids || []).map(id => allById.get(id)).filter(Boolean);

      // Pull in newly-matching items: tag overlap with the page topic, or the
      // item's type named in the page topic. Same matcher family as marking.
      const pageText = `${page.title || ''} ${page.summary || ''}`.toLowerCase();
      const newItems = allItems.filter(item =>
        !existingSet.has(item.id) && (
          (item.tags || []).some(t => pageText.includes(String(t).toLowerCase())) ||
          pageText.includes(String(item.type || '').toLowerCase())
        ),
      );

      const sourceItems = [...existingItems, ...newItems];

      // Too thin to be a page — clear the flag and move on.
      if (sourceItems.length < 2) {
        await db
          .from('concept_pages')
          .update({ is_stale: false, stale_since: null })
          .eq('id', page.id);
        continue;
      }

      const compiled = await compilePage(sourceItems, page.flavour, voice);
      if (!compiled?.title || !compiled?.summary || !compiled?.content) {
        throw new Error('empty compile result');
      }

      // Sharable only when every source item is sharable (mirrors the full pipeline).
      const allShareable = sourceItems.every(r => r.visibility === 'sharable');

      await db
        .from('concept_pages')
        .update({
          // Clean dashes the same way the full pipeline does — the recompile
          // path must never write an em/en dash to a user-facing title or body.
          title:       cleanTitle(compiled.title),
          summary:     stripDashes(compiled.summary),
          content:     stripDashes(compiled.content),
          source_ids:  sourceItems.map(i => i.id),
          version:     (page.version || 1) + 1,
          updated_at:  new Date().toISOString(),
          is_stale:    false,
          stale_since: null,
          visibility:  allShareable ? 'sharable' : 'private',
        })
        .eq('id', page.id);

      recompiled++;
    } catch (err) {
      failures++;
      // Leave the page flagged stale so a later run (or on-demand compile) retries it.
      console.error(`[recompile-stale] page ${page.id} failed:`, err?.message);
    }
  }

  await logRecompile(tenantId, failures && !recompiled ? 'failed' : 'completed', {
    recompiled,
    failures,
    staleCount: stalePages.length,
  });

  return { recompiled, failures, staleCount: stalePages.length };
  } catch (err) {
    // Catastrophic failure (DB query, perspective lookup, etc.) — anything not
    // already caught per-page. Record it so the 'started' heartbeat always has a
    // matching terminal row, then re-throw so Inngest marks the run failed and
    // retries on its own schedule.
    await logRecompile(tenantId, 'failed', { stage: 'recompile-stale', error: err?.message });
    throw err;
  }
}
