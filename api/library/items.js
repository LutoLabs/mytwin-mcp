// GET /api/library/items
//   ?type=    filter to one type (optional)
//   ?sort=    'recent' | 'alphabetical' | 'by-type' | 'most-upvoted'  (default: recent)
//   ?limit=   default 50, max 200
//   ?offset=  default 0
//   ?id=      if present, return a single item instead of a list
//
// Multi-tenant safe: every query filters by BOTH tenant_id AND user_id.
// Single-item endpoint returns 404 for any item not owned by the caller
// (does not reveal whether the id exists in another tenant).
// No cap consumed — read-only.
//
// Each item is enriched with upvote_count and viewer_has_voted. The enrichment
// is resilient: before migration 023 is applied the upvotes table is absent,
// so counts fall back to 0 and the library still renders normally.

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

// '*' (not an explicit list) so the new 030 columns (source_id, chunk_index,
// source_type) flow through when present and the endpoint never 500s on a
// pre-030 schema where they don't exist yet.
const SELECT = '*';

// Attach part_count + document_id to document/url PARENT rows (chunk_index 0) so
// the library can render a document as one card showing how many parts it holds.
// Best-effort: any error leaves the rows unenriched (rendered as a plain card).
async function enrichDocumentParents(db, items, ctx) {
  const parentSourceIds = items.filter(i => i.chunk_index === 0 && i.source_id).map(i => i.source_id);
  if (!parentSourceIds.length) return;
  try {
    const { data: parts } = await db
      .from('knowledge')
      .select('source_id')
      .eq('tenant_id', ctx.tenantId).eq('user_id', ctx.userId)
      .in('source_id', parentSourceIds).gte('chunk_index', 1);
    const counts = Object.create(null);
    for (const p of parts || []) counts[p.source_id] = (counts[p.source_id] || 0) + 1;
    for (const it of items) {
      if (it.chunk_index === 0 && it.source_id) {
        it.part_count  = counts[it.source_id] || 0;
        it.document_id = it.source_id;
      }
    }
  } catch { /* part_count is best-effort */ }
}

// Attach upvote_count + viewer_has_voted to a list of items.
// Fault-tolerant: a missing upvotes table (pre-migration) silently returns 0s.
async function enrichItems(db, items, viewerId) {
  if (!Array.isArray(items) || items.length === 0) return;
  const ids = items.map((i) => i.id);
  try {
    const { data: votes, error } = await db
      .from('upvotes')
      .select('user_id, knowledge_id')
      .in('knowledge_id', ids);
    if (error) throw error;
    const counts = Object.create(null);
    const mine   = new Set();
    for (const v of votes || []) {
      counts[v.knowledge_id] = (counts[v.knowledge_id] || 0) + 1;
      if (v.user_id === viewerId) mine.add(v.knowledge_id);
    }
    for (const it of items) {
      it.upvote_count     = counts[it.id] || 0;
      it.viewer_has_voted = mine.has(it.id);
    }
  } catch {
    for (const it of items) {
      if (typeof it.upvote_count !== 'number') it.upvote_count = 0;
      it.viewer_has_voted = false;
    }
  }
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'library_items',
    fn: async (ctx) => {
      const db = getDB();
      const {
        id,
        type,
        visibility,
        sort       = 'recent',
        limit:  rawLimit  = '50',
        offset: rawOffset = '0',
      } = req.query;

      // ── Single item detail ───────────────────────────────────────────────
      if (id) {
        const { data, error } = await db
          .from('knowledge')
          .select(SELECT)
          .eq('id', id)
          .eq('user_id', ctx.userId)
          .eq('tenant_id', ctx.tenantId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new HttpError(404, { error: 'Item not found' });
        return data;
      }

      // ── Paginated list ───────────────────────────────────────────────────
      const limit  = Math.min(Math.max(Number(rawLimit)  || 50,  1), 200);
      const offset = Math.max(Number(rawOffset) || 0, 0);

      // 'most-upvoted' uses the knowledge_with_counts view for DB-side ordering.
      // If that view is absent (pre-migration 023) we fall back to recency so
      // the library never breaks.
      let useMostUpvoted = sort === 'most-upvoted';

      if (useMostUpvoted) {
        // Probe whether the view exists by attempting the query; on error we
        // fall back gracefully below.
        const probe = await db
          .from('knowledge_with_counts')
          .select('id, user_id, type, title, content, tags, source_ref, provenance, created_at, updated_at, visibility, upvote_count', { count: 'exact' })
          .eq('user_id', ctx.userId)
          .eq('tenant_id', ctx.tenantId)
          .order('upvote_count', { ascending: false })
          .order('created_at',   { ascending: false })
          .range(offset, offset + limit - 1);

        if (!probe.error) {
          await enrichItems(db, probe.data ?? [], ctx.userId);
          return { items: probe.data ?? [], total: probe.count ?? 0, offset, limit };
        }
        // View not yet available; fall through to recency sort.
        useMostUpvoted = false;
      }

      const applyOrder = (query) => {
        switch (useMostUpvoted ? 'recent' : sort) {
          case 'alphabetical':
            return query.order('title', { ascending: true, nullsFirst: false });
          case 'by-type':
            return query.order('type', { ascending: true }).order('created_at', { ascending: false });
          default:
            return query.order('created_at', { ascending: false });
        }
      };

      // Collapse documents in the DEFAULT browse view only: hide document/url
      // PARTS (chunk_index >= 1) so each document shows as ONE representative card
      // (its chunk_index 0 parent). Voice items stay flat (they have no parent);
      // standalone items (chunk_index null) are unaffected. A type or visibility
      // filter means the user is drilling in, so parts show flat — otherwise a
      // "knowledge" filter would hide document chunks whose parent is "document".
      const collapse = (!type || type === 'all') && visibility !== 'private' && visibility !== 'sharable';

      const buildList = (withCollapse) => {
        let query = db.from('knowledge').select(SELECT, { count: 'exact' })
          .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId);
        if (type && type !== 'all') query = query.eq('type', type);
        if (visibility === 'private' || visibility === 'sharable') query = query.eq('visibility', visibility);
        if (withCollapse) query = query.or('chunk_index.is.null,chunk_index.eq.0,source_type.eq.voice-note');
        return applyOrder(query).range(offset, offset + limit - 1);
      };

      let { data, error, count } = await buildList(collapse);
      // Resilient: pre-030 the chunk_index column doesn't exist, so the collapse
      // filter errors. Retry once without it so the library still renders (flat).
      if (error && collapse && /chunk_index|source_id|column|schema cache/i.test(error.message || '')) {
        ({ data, error, count } = await buildList(false));
      }
      if (error) throw new Error(error.message);

      await enrichItems(db, data ?? [], ctx.userId);
      await enrichDocumentParents(db, data ?? [], ctx);

      return { items: data ?? [], total: count ?? 0, offset, limit };
    },
  });
}
