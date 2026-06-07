// GET /api/library/item/[id]
//
// Extended single-item detail endpoint for the library detail view.
// Returns the item itself plus fast DB-backed contextual panels (siblings and
// concept pages) — all in one round-trip.
//
// Related items (Pinecone) are fetched separately via /api/library/item/[id]/related
// so the detail view can render this response immediately without waiting for
// the vector search to complete.
//
// Response:
//   {
//     item:          KnowledgeItem,
//     siblings:      { id, title }[],                     — same source_ref, sorted by title
//     concept_pages: { id, flavour, title, summary }[],   — concepts this item feeds into
//   }
//
// Multi-tenant safe: every query filters by both tenant_id AND user_id.
// Returns 404 for any item not owned by the caller.

import { methodGuard, runTwin, HttpError } from '../../../lib/twin-api.js';
import { getDB } from '../../../lib/supabase.js';

// '*' so the 030 columns (source_id, chunk_index) flow through when present and
// the detail endpoint never 500s on a pre-030 schema.
const ITEM_SELECT    = '*';
const SIBLING_SELECT = 'id, title, chunk_index';
const CONCEPT_SELECT = 'id, flavour, title, summary';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH'])) return;

  return runTwin(req, res, {
    toolName: 'library_item_detail',
    fn: async (ctx) => {
      const { id } = req.query;
      if (!id) throw new HttpError(400, { error: 'id is required' });

      const db = getDB();

      // ── PATCH — update visibility ──────────────────────────────────────────
      if (req.method === 'PATCH') {
        const { visibility } = req.body || {};
        if (!['private', 'sharable'].includes(visibility)) {
          throw new HttpError(400, { error: 'visibility must be "private" or "sharable"' });
        }
        const { data, error } = await db
          .from('knowledge')
          .update({ visibility })
          .eq('id', id)
          .eq('user_id',   ctx.userId)
          .eq('tenant_id', ctx.tenantId)
          .select('id, visibility')
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new HttpError(404, { error: 'Item not found' });
        return { id: data.id, visibility: data.visibility };
      }

      // ── Fetch the item itself first ───────────────────────────────────────
      const { data: item, error: itemErr } = await db
        .from('knowledge')
        .select(ITEM_SELECT)
        .eq('id',         id)
        .eq('user_id',   ctx.userId)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle();

      if (itemErr) throw new Error(itemErr.message);
      if (!item)   throw new HttpError(404, { error: 'Item not found' });

      // ── Fetch siblings and concept pages in parallel ──────────────────────
      const [siblingsResult, conceptsResult, originalResult] = await Promise.allSettled([

        // 1. Siblings — same source_ref, different id, sorted naturally
        (async () => {
          if (!item.source_ref || item.source_ref === 'source not recorded') return [];
          // Order by chunk_index so parts read 1..N (the parent is 0), falling
          // back to title. Title-only sort mis-ordered "part 10" before "part 2".
          const { data, error } = await db
            .from('knowledge')
            .select(SIBLING_SELECT)
            .eq('tenant_id',  ctx.tenantId)
            .eq('user_id',    ctx.userId)
            .eq('source_ref', item.source_ref)
            .neq('id',        id)
            .order('chunk_index', { ascending: true, nullsFirst: true })
            .order('title',       { ascending: true });
          if (error) { console.error('[item-detail] siblings error:', error.message); return []; }
          return data || [];
        })(),

        // 2. Concept pages this item feeds into
        (async () => {
          const { data, error } = await db
            .from('concept_pages')
            .select(CONCEPT_SELECT)
            .eq('tenant_id', ctx.tenantId)
            .eq('user_id',   ctx.userId)
            .contains('source_ids', [id]);
          if (error) { console.error('[item-detail] concepts error:', error.message); return []; }
          return data || [];
        })(),

        // 3. Original-binary availability (Phase 4). Resilient pre-031 (the
        // original_* columns don't exist → error → treated as unavailable).
        (async () => {
          if (!item.source_id) return null;
          const { data, error } = await db
            .from('sources')
            .select('id, reference, original_key, original_mime, original_bytes')
            .eq('id', item.source_id).eq('tenant_id', ctx.tenantId)
            .maybeSingle();
          if (error || !data || !data.original_key) return null;
          return { available: true, source_id: data.id, filename: data.reference, mime: data.original_mime, bytes: data.original_bytes };
        })(),
      ]);

      return {
        item,
        siblings:      siblingsResult.status === 'fulfilled' ? siblingsResult.value : [],
        concept_pages: conceptsResult.status === 'fulfilled' ? conceptsResult.value : [],
        original:      originalResult.status === 'fulfilled' ? originalResult.value : null,
      };
    },
  });
}
