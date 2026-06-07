// Supabase Storage access for original document binaries (Phase 4).
//
// The app uses its OWN JWT (not Supabase Auth) and the service-role key for all
// data access, so the browser cannot talk to Storage directly. Instead the server
// (service role) mints short-lived SIGNED URLs:
//   * a signed UPLOAD url the browser PUTs the original file to (direct to
//     Storage, so it bypasses the serverless request-body size limit), and
//   * a signed DOWNLOAD url the browser is redirected to.
//
// The bucket is PRIVATE; nothing is publicly readable. The signed urls expire.
//
// Bucket name is configurable via DOCUMENTS_BUCKET (defaults to "documents").
// All of this is best-effort: if the bucket doesn't exist yet, these throw and the
// callers treat originals as simply unavailable — ingestion is never affected.

import { getDB } from './supabase.js';

export function documentsBucket() {
  return process.env.DOCUMENTS_BUCKET || 'documents';
}

// Build a tenant-scoped object path. Tenant + source in the path keeps every
// document's binary isolated and easy to reason about / clean up.
export function originalKey({ tenantId, sourceId, filename }) {
  const safe = String(filename || 'original')
    .replace(/[^\w.\-]+/g, '_')   // keep it a clean single path segment
    .slice(0, 120);
  return `${tenantId}/${sourceId}/${safe}`;
}

// Supabase returns signedUrl either absolute or as a path; normalise to absolute.
function absolute(signedUrl) {
  if (!signedUrl) return null;
  if (/^https?:\/\//i.test(signedUrl)) return signedUrl;
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const rel  = signedUrl.startsWith('/') ? signedUrl : `/${signedUrl}`;
  // Newer supabase-js returns paths already prefixed with /storage/v1; older ones
  // return /object/... — prefix /storage/v1 only when it's missing.
  const withApi = rel.startsWith('/storage/v1') ? rel : `/storage/v1${rel}`;
  return base + withApi;
}

// A signed URL the browser PUTs the original file to. Returns the full upload URL
// plus the object key. The token is embedded in the URL.
export async function createUploadUrl(key) {
  const { data, error } = await getDB().storage.from(documentsBucket()).createSignedUploadUrl(key);
  if (error) throw new Error(error.message);
  return { uploadUrl: absolute(data.signedUrl), key };
}

// A short-lived signed URL to download the stored original. `download` (a
// filename) makes the browser save rather than render it inline.
// expiresIn kept short (5 min): the signed URL embeds a scoped JWT in its
// ?token= query and the download fires immediately, so a long window only widens
// the leak surface (logs/history/Referer) for no benefit. (B6 hardening.)
export async function createDownloadUrl(key, { download, expiresIn = 300 } = {}) {
  const opts = download ? { download } : undefined;
  const { data, error } = await getDB().storage.from(documentsBucket()).createSignedUrl(key, expiresIn, opts);
  if (error) throw new Error(error.message);
  return absolute(data.signedUrl);
}

// Best-effort delete of a stored original (used by the document replace/delete
// paths so an orphaned binary doesn't linger). Never throws.
export async function deleteOriginal(key) {
  if (!key) return;
  try { await getDB().storage.from(documentsBucket()).remove([key]); }
  catch (err) { console.error('[blob] deleteOriginal failed:', err?.message); }
}
