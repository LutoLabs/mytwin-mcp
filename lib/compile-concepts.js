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

const THINKING_SYSTEM = `You are compiling a concept page for a personal AI twin.

Your job is to synthesise stored knowledge items into a concept page about how this person thinks.

Rules:
- Write in second person ("You believe...", "Your approach is...", "You tend to...")
- Flowing prose, no headers. Use markdown lightly: **bold** for key claims, *italics* for emphasis.
- Do not invent. Do not generalise beyond what the items contain.
- Surface tensions, open questions, or evolution visible across the items if present.
- Be specific. Name the actual views, not vague descriptions of having views.

Return valid JSON only — no explanation, no markdown fences:
{"title": "...", "summary": "...", "content": "..."}

title: "How they think about [concept]" — infer the concept from the items.
summary: One sentence capturing the core view.
content: The compiled page body (markdown prose, 200-500 words).`;

const CRAFT_SYSTEM = `You are compiling a craft page for a personal AI twin.

Your job is to synthesise stored items into a concept page about how this person creates.

Rules:
- Write in second person ("You open with...", "You never use...", "Your pattern is...")
- Flowing prose, no headers. Use markdown lightly: **bold** for definitive patterns, *italics* for examples.
- Do not invent. Pull patterns from what the items actually show.
- Include specific phrases, examples, or structural patterns from the items where illustrative.
- Cover: their voice and style principles, what they always do, what they never do.

Return valid JSON only — no explanation, no markdown fences:
{"title": "...", "summary": "...", "content": "..."}

title: "How they write/create [output type]" — infer from items.
summary: One sentence capturing their defining approach.
content: The compiled page body (markdown prose, 200-500 words).`;

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

export async function compilePage(items, flavour) {
  const itemsText = items.map(i =>
    `---\nTitle: ${i.title || '(no title)'}\nType: ${i.type}\nDate: ${i.created_at?.slice(0, 10) || '?'}\n\n${(i.content || '').slice(0, 2000)}`
  ).join('\n\n');

  const systemPrompt = flavour === 'knowledge' ? THINKING_SYSTEM : CRAFT_SYSTEM;

  // json_schema output guarantees well-formed JSON — the free-form prose body
  // used to break JSON.parse when it contained an unescaped quote or newline.
  const msg = await client().messages.create({
    model: 'claude-sonnet-4-6',
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
    // Update existing page — merge source_ids, bump version
    const mergedIds = [...new Set([...bestMatch.source_ids, ...sourceIds])];
    await db
      .from('concept_pages')
      .update({
        title,
        summary,
        content,
        source_ids: mergedIds,
        version:    bestMatch.version + 1,
        updated_at: new Date().toISOString(),
        visibility,
      })
      .eq('id', bestMatch.id);
  } else {
    // Insert new page
    await db
      .from('concept_pages')
      .insert({
        tenant_id:  tenantId,
        user_id:    userId,
        flavour,
        title,
        summary,
        content,
        source_ids: sourceIds,
        version:    1,
        visibility,
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

// Clusters are capped at 10, so a concurrency of 10 compiles them in a single
// wave — keeps wall-clock well inside the function budget for large twins.
const COMPILE_CONCURRENCY = 10;

export async function compileConceptsForTenant({ userId, tenantId }) {
  const db = getDB();

  const { data: items, error } = await db
    .from('knowledge')
    .select('id, type, title, content, tags, created_at, visibility')
    .eq('user_id',   userId)
    .eq('tenant_id', tenantId);

  if (error) {
    await logCompile(tenantId, 'failed', { stage: 'fetch', error: error.message });
    throw new Error(`[compile-concepts] fetch error: ${error.message}`);
  }
  if (!items?.length || items.length < 2) {
    await logCompile(tenantId, 'skipped', { reason: 'not_enough_items', items: items?.length || 0 });
    return { clusters: 0, pagesWritten: 0, failures: 0, skipped: true };
  }

  // Single clustering pass over ALL items — LLM assigns flavour per cluster.
  // A clustering failure is fatal: with no clusters we would write zero pages,
  // which presents to the user as an eternal "still compiling". Surface it.
  let clusters;
  try {
    clusters = await clusterItems(items);
  } catch (err) {
    await logCompile(tenantId, 'failed', { stage: 'cluster', items: items.length, error: err.message });
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
    await logCompile(tenantId, 'completed', { clusters: 0, pagesWritten: 0, failures: 0 });
    return { clusters: 0, pagesWritten: 0, failures: 0 };
  }

  // Compile pages with bounded concurrency: fast enough to finish inside the
  // 120s function budget, gentle enough not to hammer the API all at once.
  let pagesWritten = 0;
  let failures = 0;

  for (let i = 0; i < jobs.length; i += COMPILE_CONCURRENCY) {
    const batch = jobs.slice(i, i + COMPILE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async ({ cluster, clusterRows, flavour }) => {
      const page = await compilePage(clusterRows, flavour);
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
        title:      page.title,
        summary:    page.summary,
        content:    page.content,
        sourceIds:  clusterRows.map(r => r.id),
        visibility: allShareable ? 'sharable' : 'private',
      });
    }));

    for (const r of results) {
      if (r.status === 'fulfilled') { pagesWritten++; }
      else { failures++; console.error('[compile-concepts] page compile failed:', r.reason?.message); }
    }
  }

  const summary = { clusters: jobs.length, pagesWritten, failures };

  // If every cluster failed to compile, the run did not succeed — fail loudly.
  if (pagesWritten === 0) {
    await logCompile(tenantId, 'failed', { stage: 'compile', ...summary });
    throw new Error(`[compile-concepts] all ${jobs.length} cluster compiles failed`);
  }

  await logCompile(tenantId, 'completed', summary);
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
    .select('type, title, tags')
    .eq('id', itemId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!item) return 0;

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
  const db = getDB();

  const { data: stalePages } = await db
    .from('concept_pages')
    .select('id, flavour, title, summary, source_ids, version, visibility')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('is_stale', true);
  if (!stalePages?.length) return { recompiled: 0, staleCount: 0 };

  // Source of truth for expansion — all current items for this tenant.
  const { data: allItems } = await db
    .from('knowledge')
    .select('id, type, title, content, tags, created_at, visibility')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId);
  if (!allItems?.length) {
    // Nothing to compile from — clear the flags so we don't loop.
    await db
      .from('concept_pages')
      .update({ is_stale: false, stale_since: null })
      .in('id', stalePages.map(p => p.id));
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

      const compiled = await compilePage(sourceItems, page.flavour);
      if (!compiled?.title || !compiled?.summary || !compiled?.content) {
        throw new Error('empty compile result');
      }

      // Sharable only when every source item is sharable (mirrors the full pipeline).
      const allShareable = sourceItems.every(r => r.visibility === 'sharable');

      await db
        .from('concept_pages')
        .update({
          title:       compiled.title,
          summary:     compiled.summary,
          content:     compiled.content,
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

  await logCompile(tenantId, failures && !recompiled ? 'failed' : 'completed', {
    stage: 'recompile-stale',
    recompiled,
    failures,
    staleCount: stalePages.length,
  });

  return { recompiled, failures, staleCount: stalePages.length };
}
