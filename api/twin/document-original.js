// /api/twin/document-original — original-binary storage for a document (Phase 4).
//
//   POST   { source_id, filename, mime }   → { upload_url, key }   sign a direct
//                                            browser → Storage upload
//   PATCH  { source_id, key, mime, bytes }  → { ok }               record the stored
//                                            original on the sources parent
//   GET    ?source_id=                       → { download_url, filename }  short-lived
//                                            signed download url
//
// Everything is tenant-scoped: the source_id must belong to the caller's tenant.
// Best-effort by design — if the Storage bucket or migration 031 isn't there yet,
// these return an unavailable signal (never 500 the upload flow). The original is
// a bonus on top of the already-stored extracted text.

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';
import { createUploadUrl, createDownloadUrl, originalKey } from '../../lib/blob.js';

// Look up a source the caller owns. select('*') so it never 500s on a pre-031
// schema (the original_* columns simply come back undefined).
async function ownedSource(db, ctx, sourceId) {
  const { data, error } = await db.from('sources')
    .select('*')
    .eq('id', sourceId).eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH'])) return;

  return runTwin(req, res, {
    toolName: 'document_original',
    fn: async (ctx) => {
      const db = getDB();

      // ── GET — signed download url ─────────────────────────────────────────
      if (req.method === 'GET') {
        const sourceId = req.query.source_id;
        if (!sourceId) throw new HttpError(400, { error: 'source_id is required' });
        const source = await ownedSource(db, ctx, sourceId);
        if (!source) throw new HttpError(404, { error: 'Document not found' });
        if (!source.original_key) return { available: false };
        try {
          const url = await createDownloadUrl(source.original_key, { download: source.reference || 'document' });
          return { available: true, download_url: url, filename: source.reference || 'document' };
        } catch (err) {
          console.error('[document-original] download url failed:', err?.message);
          return { available: false, reason: 'storage_unavailable' };
        }
      }

      // ── POST — sign a direct upload ───────────────────────────────────────
      if (req.method === 'POST') {
        const { source_id, filename } = req.body || {};
        if (!source_id) throw new HttpError(400, { error: 'source_id is required' });
        const source = await ownedSource(db, ctx, source_id);
        if (!source) throw new HttpError(404, { error: 'Document not found' });
        const key = originalKey({ tenantId: ctx.tenantId, sourceId: source_id, filename: filename || source.reference });
        try {
          const { uploadUrl } = await createUploadUrl(key);
          return { available: true, upload_url: uploadUrl, key };
        } catch (err) {
          // No bucket yet (or Storage error) — tell the client to skip silently.
          console.error('[document-original] sign upload failed:', err?.message);
          return { available: false, reason: 'storage_unavailable' };
        }
      }

      // ── PATCH — finalize (record the stored original) ─────────────────────
      const { source_id, key, mime, bytes } = req.body || {};
      if (!source_id || !key) throw new HttpError(400, { error: 'source_id and key are required' });
      const source = await ownedSource(db, ctx, source_id);
      if (!source) throw new HttpError(404, { error: 'Document not found' });
      const { error } = await db.from('sources')
        .update({ original_key: key, original_mime: mime || null, original_bytes: Number(bytes) || null })
        .eq('id', source_id).eq('tenant_id', ctx.tenantId);
      if (error) {
        // Pre-031 the columns don't exist — accept gracefully (original just isn't
        // recorded until the migration lands).
        if (/column|schema cache|original_/i.test(error.message || '')) return { ok: false, reason: 'pre_migration' };
        throw new Error(error.message);
      }
      return { ok: true };
    },
  });
}
