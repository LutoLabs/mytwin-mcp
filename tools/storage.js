import dns from 'node:dns/promises';
import net from 'node:net';
import { getDB } from '../lib/supabase.js';
import { getNamespace } from '../lib/pinecone.js';
import { embed, autoTag, analyseUrl, extractFromVoiceNote } from '../lib/embed.js';
import { UserError } from '../lib/errors.js';
import { formatDisplayRef } from '../lib/display-ref.js';
import { cleanTitle, stripDashes } from '../lib/text-clean.js';
import { hashChunk, hashDocument } from '../lib/content-hash.js';
import { deleteOriginal } from '../lib/blob.js';

// ── Input size limits ─────────────────────────────────────────────────────────
// Per the security brief. Each limit produces a UserError surfaced to the
// caller; we never silently truncate.
const MAX_KNOWLEDGE_CHARS = 50_000;
const MAX_VOICE_NOTE_CHARS = 50_000;
const MAX_DOCUMENT_CHARS  = 500_000;
const MAX_TITLE_CHARS     = 500;
const MAX_URL_FETCH_BYTES = 1_000_000;
const URL_FETCH_TIMEOUT_MS = 15_000;

function assertLength(field, value, max) {
  if (typeof value === 'string' && value.length > max) {
    throw new UserError(`${field} exceeds the ${max.toLocaleString()} character limit (got ${value.length.toLocaleString()}). Trim it down and try again.`);
  }
}

// ── SSRF guard ────────────────────────────────────────────────────────────────
// Blocks: non-https schemes, private/reserved IPv4 + IPv6 ranges, cloud
// metadata endpoints, localhost. Resolves DNS up-front and validates the
// resulting IP, then disables redirect following so a 30x can't escape the
// check. Note: this does not defend against full DNS rebinding (server may
// re-resolve at TCP time); acceptable trade-off for MVP.
function isPrivateOrReservedIp(ip) {
  if (/^0\./.test(ip)) return true;                                    // 0.0.0.0/8
  if (/^10\./.test(ip)) return true;                                   // 10.0.0.0/8
  if (/^127\./.test(ip)) return true;                                  // loopback
  if (/^169\.254\./.test(ip)) return true;                             // link-local incl. AWS/GCP metadata
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;           // 172.16/12
  if (/^192\.168\./.test(ip)) return true;                             // 192.168/16
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(ip)) return true; // 100.64/10 CGN
  if (ip === '::1' || ip === '::') return true;                        // IPv6 loopback / unspecified
  const lo = ip.toLowerCase();
  if (/^fc[0-9a-f]{2}:/.test(lo) || /^fd[0-9a-f]{2}:/.test(lo)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(lo)) return true;                            // fe80::/10
  if (lo.startsWith('::ffff:')) return isPrivateOrReservedIp(lo.slice(7));   // IPv4-mapped
  return false;
}

async function validateUrlForFetch(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch {
    throw new UserError('That URL is not valid. Provide a fully qualified https:// URL.');
  }
  if (url.protocol !== 'https:') {
    throw new UserError('Only https:// URLs are supported.');
  }
  let host = url.hostname;
  // URL parser wraps IPv6 literals in brackets — unwrap for IP checks/DNS
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /^(localhost|0\.0\.0\.0)$/i.test(host)) {
    throw new UserError('That URL resolves to a private or reserved network address and was blocked.');
  }
  // Literal IP (no DNS needed) — validate directly
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new UserError('That URL resolves to a private or reserved network address and was blocked.');
    }
    return url.toString();
  }
  // Hostname — resolve DNS and validate every returned address
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UserError(`Could not resolve ${host}. Check the URL and try again.`);
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new UserError('That URL resolves to a private or reserved network address and was blocked.');
    }
  }
  return url.toString();
}

async function fetchWithSizeCap(safeUrl) {
  const res = await fetch(safeUrl, {
    headers: { 'User-Agent': 'MyTwin-MCP/2.0' },
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
    redirect: 'error', // redirects could escape SSRF check
  });
  if (!res.ok) {
    throw new UserError(`Could not fetch URL: server returned HTTP ${res.status}.`);
  }
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared && declared > MAX_URL_FETCH_BYTES) {
    throw new UserError(`That page is ${(declared / 1_000_000).toFixed(1)} MB — exceeds the 1 MB cap.`);
  }
  // Stream-cap regardless of declared content-length
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_URL_FETCH_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new UserError('That page exceeds the 1 MB cap.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder('utf-8').decode(all);
}

function pineconeId() {
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sbError(op, error) {
  console.error(`[mytwin/supabase] ${op} failed:`, {
    message: error.message,
    code:    error.code,
    details: error.details,
    hint:    error.hint,
    status:  error.status,
  });
  const err = new Error(error.message);
  err.code    = error.code;
  err.details = error.details;
  err.hint    = error.hint;
  err.status  = error.status;
  return err;
}

// ── document-model resilience ───────────────────────────────────────────────────
//
// The 030 migration adds knowledge.{source_id,chunk_index,content_hash} and
// sources.{full_text,content_hash}. To survive the window between code deploy and
// migration apply (the same lag lib/groups.js handles for the 028 openness
// column), inserts that include those columns retry once without them if the DB
// reports the column doesn't exist. Vector metadata is schemaless, so it always
// carries the new fields regardless.

function isUnknownColumnError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'PGRST204' || code === '42703') return true;
  const msg = String(error.message || '') + ' ' + String(error.details || '');
  return /column .* does not exist|could not find the .* column|schema cache/i.test(msg);
}

async function insertWithOptionalCols(db, table, row, optionalCols, selectCols = '*') {
  let res = await db.from(table).insert(row).select(selectCols).single();
  if (res.error && isUnknownColumnError(res.error) && optionalCols.some(c => c in row)) {
    const fallback = { ...row };
    for (const c of optionalCols) delete fallback[c];
    res = await db.from(table).insert(fallback).select(selectCols).single();
  }
  return res;
}

const KNOWLEDGE_DOC_COLS = ['content_hash', 'source_id', 'chunk_index'];
const SOURCE_DOC_COLS    = ['full_text', 'content_hash'];

// Idempotency lookup: has this exact document (same tenant) already been ingested?
// Resilient to a pre-030 schema (returns null, so idempotency is simply inactive
// until the migration lands). Fails open to "no duplicate" on any other error so
// a transient fault never blocks a genuine ingest — the retrieval-layer content
// dedupe still prevents a duplicate from surfacing twice in one answer.
async function findExistingDocument(db, tenantId, contentHash) {
  if (!contentHash) return null;
  const res = await db.from('sources')
    .select('id, reference, ingested_at, content_hash')
    .eq('tenant_id', tenantId).eq('content_hash', contentHash)
    .order('ingested_at', { ascending: true }).limit(1).maybeSingle();
  if (res.error) {
    if (!isUnknownColumnError(res.error)) {
      console.error('[mytwin] findExistingDocument failed (allowing ingest):', res.error.message);
    }
    return null;
  }
  return res.data || null;
}

// Embed a faithful one-line document summary as the PARENT vector (chunk_index 0,
// is_document_parent metadata). The "whole document" notion retrieval can match
// and expand from. Shared by document + url ingest. Best-effort: never throws
// into the caller, so a parent failure can't lose chunks that already stored.
async function storeParentSummary(ctx, { sourceId, summary, sourceRef, sourceType, docAutoTags }) {
  if (!sourceId || typeof summary !== 'string' || !summary.trim()) return null;
  try {
    const r = await addKnowledge(ctx, {
      type:                  'document',
      content:               stripDashes(summary).slice(0, 500),
      title:                 sourceRef,
      source_type:           sourceType,
      source_ref:            sourceRef,
      precomputed_auto_tags: docAutoTags || [],
      source_id:             sourceId,
      chunk_index:           0,
      is_document_parent:    true,
    });
    return r.id;
  } catch (err) {
    console.error('[mytwin] parent summary vector failed:', err.message);
    return null;
  }
}

// Remove a document entirely: its parent + chunk knowledge rows (and their
// Pinecone vectors) and the sources parent row. Hard-scoped to the caller's
// tenant. Used by the replace flow and the Phase 3 collapse. Pre-030 (no
// source_id column) it deletes nothing and reports 0.
export async function deleteDocument(ctx, sourceId) {
  if (!sourceId) return { deleted: 0 };
  const db = getDB();

  let rows = [];
  const res = await db.from('knowledge')
    .select('id, pinecone_id')
    .eq('tenant_id', ctx.tenantId).eq('source_id', sourceId);
  if (!res.error) rows = res.data || [];
  else if (!isUnknownColumnError(res.error)) {
    console.error('[mytwin] deleteDocument chunk lookup failed:', res.error.message);
  }

  const pineconeIds = rows.map(r => r.pinecone_id).filter(Boolean);
  if (pineconeIds.length) {
    try { await getNamespace(ctx.tenantId).deleteMany(pineconeIds); }
    catch (err) { console.error('[mytwin] deleteDocument vector delete failed:', err.message); }
  }
  if (rows.length) {
    await db.from('knowledge').delete().eq('tenant_id', ctx.tenantId).in('id', rows.map(r => r.id));
  }
  // Remove the stored original binary too (best-effort; pre-031 the column is
  // absent → the lookup errors and we just skip).
  try {
    const { data: src } = await db.from('sources')
      .select('original_key').eq('tenant_id', ctx.tenantId).eq('id', sourceId).maybeSingle();
    if (src?.original_key) await deleteOriginal(src.original_key);
  } catch { /* pre-031 or storage error — ignore */ }
  await db.from('sources').delete().eq('tenant_id', ctx.tenantId).eq('id', sourceId);

  return { deleted: rows.length };
}

// ── add_knowledge ─────────────────────────────────────────────────────────────

const VALID_PROVENANCE = new Set(['personal', 'organisational', 'employer', 'client', 'external']);

export async function addKnowledge(ctx, { type, content, title, source_type = 'typed', source_ref, tags, manual_tags, provenance, precomputed_auto_tags, is_living_document, source_id, chunk_index, is_document_parent }) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new UserError('Content is required.');
  }
  assertLength('Content', content, MAX_KNOWLEDGE_CHARS);
  assertLength('Title',   title,   MAX_TITLE_CHARS);

  // No stored title ever carries an em or en dash (the founder's rule). Join the
  // two phrases with a comma so the title reads identically everywhere it shows.
  title = cleanTitle(title);

  // Default to 'personal' — matches the DB column default. The system prompt
  // guides Claude to propose the correct provenance per record; this is the
  // fallback if the proposal sequence didn't supply one.
  const prov = provenance && VALID_PROVENANCE.has(provenance) ? provenance : 'personal';

  const db = getDB();

  // precomputed_auto_tags lets addDocument run one doc-level autoTag pass and
  // share the result across every chunk — avoids ~40 sequential gpt-4o-mini
  // round-trips on a long document. When not provided (typical path), behave
  // as before: tag the content directly.
  const autoTags = Array.isArray(precomputed_auto_tags)
    ? precomputed_auto_tags
    : await autoTag(content, manual_tags || []);
  const allTags  = [...new Set([...(manual_tags || []), ...autoTags])];

  const pid         = pineconeId();
  const contentHash = hashChunk(content);
  const embedding   = await embed(content);

  // Document-model columns (source_id, chunk_index, content_hash) are written
  // when present; insertWithOptionalCols degrades gracefully pre-030.
  const row = {
    user_id:            ctx.userId,
    tenant_id:          ctx.tenantId,
    type, title, content, source_type,
    source_ref:         source_ref || null,
    tags:               allTags,
    pinecone_id:        pid,
    provenance:         prov,
    is_living_document: Boolean(is_living_document),
    content_hash:       contentHash,
  };
  if (source_id != null)   row.source_id   = source_id;
  if (chunk_index != null) row.chunk_index = chunk_index;

  const { data, error } = await insertWithOptionalCols(db, 'knowledge', row, KNOWLEDGE_DOC_COLS);
  if (error) throw sbError('knowledge.insert', error);

  // knowledge_type duplicates `type` for filtered retrieval (search_for_creation
  // queries by knowledge_type). The Pinecone wrapper would auto-fill this if we
  // forgot — being explicit here keeps reads + writes symmetric. content_hash
  // powers retrieval-time chunk dedupe; document_id/chunk_index/is_document_parent
  // power whole-document grouping + expand. Pinecone rejects null values, so each
  // optional key is added only when defined.
  const metadata = {
    knowledge_id:   data.id,
    user_id:        ctx.userId,
    tenant_id:      ctx.tenantId,
    type,
    knowledge_type: type,
    provenance:     prov,
    source_type,
    source_ref:     source_ref || '',
    created_at:     data.created_at,
    content_hash:   contentHash,
  };
  if (source_id != null)   metadata.document_id = source_id;   // brief: document_id == source_id
  if (chunk_index != null) metadata.chunk_index = chunk_index;
  if (is_document_parent)  metadata.is_document_parent = true;

  await getNamespace(ctx.tenantId).upsert([{ id: pid, values: embedding, metadata }]);

  return {
    stored: true,
    id: data.id,
    display_ref: formatDisplayRef({ id: data.id, title }),
    type,
    title: title || null,
    tags: allTags,
    auto_tagged: autoTags,
    provenance: prov,
    source: source_type === 'typed' ? 'typed directly' : `${source_type}: ${source_ref}`,
  };
}

// ── add_from_url ──────────────────────────────────────────────────────────────

export async function addFromUrl(ctx, { url, notes }) {
  // Validate URL + resolve DNS + block private/reserved IPs FIRST, before
  // allocating any resources (DB, embeddings, etc). Fail fast on bad input.
  const safeUrl = await validateUrlForFetch(url);

  const db = getDB();

  let html;
  try {
    html = await fetchWithSizeCap(safeUrl);
  } catch (err) {
    if (err?.userFacing) throw err;
    throw new UserError(`Could not fetch ${url}: ${err.message}`);
  }

  const text = stripHtml(html);
  if (text.length < 100) throw new UserError('Page has too little readable content.');

  const { data: types } = await db.from('schema_types').select('name').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId);
  const typeNames = (types || []).map(t => t.name);

  const analysis = await analyseUrl(text, typeNames);

  if (!analysis.items?.length) {
    return { stored: false, url, reason: 'No knowledge worth storing found in this page', summary: analysis.summary };
  }

  // Retain the raw stripped page text on the source row (same source-of-truth
  // layer as documents) and group the extracted items under it via source_id.
  // No content_hash here on purpose: re-fetching a URL is a legitimate refresh,
  // not a duplicate, so we leave it exempt from the (tenant, content_hash) index.
  const { data: source } = await insertWithOptionalCols(db, 'sources', {
    user_id:     ctx.userId,
    tenant_id:   ctx.tenantId,
    source_type: 'url',
    reference:   url,
    summary:     analysis.summary,
    item_count:  analysis.items.length,
    full_text:   text,
  }, SOURCE_DOC_COLS);
  const sourceId = source?.id || null;

  const stored = [];
  let idx = 0;
  for (const item of analysis.items) {
    const result = await addKnowledge(ctx, {
      type:        item.type || 'knowledge',
      title:       item.title,
      content:     item.content,
      source_type: 'url',
      source_ref:  url,
      manual_tags: item.tags || [],
      source_id:   sourceId,
      chunk_index: ++idx,
    });
    stored.push(result);
  }

  // Parent summary vector — the whole-page notion, mirroring documents.
  if (sourceId) {
    await storeParentSummary(ctx, {
      sourceId, summary: analysis.summary, sourceRef: url,
      sourceType: 'url', docAutoTags: [],
    });
  }

  return {
    stored: true,
    url,
    summary: analysis.summary,
    items_extracted: analysis.items.length,
    items: stored,
    source_id: sourceId,
    document_id: sourceId,
  };
}

// ── add_document ──────────────────────────────────────────────────────────────
//
// `type` controls the storage strategy:
//   - 'skill'     → stored as ONE record (no chunking). Skills are reusable
//                   writing guides, templates, voice frameworks — they are most
//                   useful when retrieved whole in creation mode.
//   - 'knowledge' → chunked for fine-grained retrieval (default).

export async function addDocument(ctx, { filename, content, notes, type = 'knowledge', summary, replace = false, replaceSourceId = null }) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new UserError('Document content is required.');
  }
  assertLength('Document', content, MAX_DOCUMENT_CHARS);

  const db = getDB();
  const knowledgeType = type === 'skill' ? 'skill' : 'knowledge';
  const docHash = hashDocument(content, ctx.tenantId);

  // ── Idempotency. The same document (same tenant) is never silently stored
  // twice. If it already exists and the caller didn't ask to replace, return a
  // duplicate signal so the UI can offer "already in your twin, replace it?".
  //
  // replaceSourceId (connector edit-in-place): target an EXACT source row
  // regardless of content hash. An edited remote item (e.g. a re-transcribed
  // meeting) hashes differently, so hash lookup would miss it and duplicate —
  // but the connector already knows which source this external id maps to.
  let existing = null;
  if (replaceSourceId) {
    const res = await db.from('sources')
      .select('id, ingested_at, reference')
      .eq('id', replaceSourceId).eq('tenant_id', ctx.tenantId).maybeSingle();
    existing = res.data || null;
    if (existing) replace = true;   // force replace semantics onto the known row
  } else {
    existing = await findExistingDocument(db, ctx.tenantId, docHash);
    if (existing && !replace) {
      return {
        stored:               false,
        duplicate:            true,
        existing_source_id:   existing.id,
        existing_ingested_at: existing.ingested_at,
        reference:            existing.reference,
        message:              'This document is already in your twin.',
      };
    }
  }
  // Single doc-level autoTag pass shared across all storage paths.
  const docAutoTags = await autoTag(content, []);

  // Faithful one-line summary for the parent record. Prefer the summary the
  // propose step already generated; fall back to the document head. Dash-cleaned
  // either way (founder rule: generated summaries carry no em/en dashes).
  const docSummary = stripDashes(
    (typeof summary === 'string' && summary.trim()) ? summary.trim() : content.slice(0, 240)
  ).slice(0, 500);

  // ── Document parent row (sources). Holds the RAW full extracted text (the
  // source-of-truth layer, immutable once written) + the idempotency hash.
  //
  // Replace vs fresh. On REPLACE we REUSE the existing source row (its
  // content_hash is identical by construction, so re-inserting would collide with
  // the unique index) and capture its current children so we can delete them ONLY
  // AFTER the new copy is confirmed written. We never tear down the only good copy
  // first: a mid-write failure below leaves the prior document fully intact.
  let sourceId = null;
  let oldChildIds = [];
  let oldChildVecs = [];
  let reusedSource = false;

  if (existing && replace) {
    sourceId = existing.id;
    reusedSource = true;
    const { data: oldKids } = await db.from('knowledge')
      .select('id, pinecone_id').eq('tenant_id', ctx.tenantId).eq('source_id', sourceId);
    oldChildIds  = (oldKids || []).map(r => r.id);
    oldChildVecs = (oldKids || []).map(r => r.pinecone_id).filter(Boolean);
    // Edited content (replaceSourceId path) hashes differently, so persist the
    // NEW hash. The hash-match replace path leaves it unchanged. Resilient
    // pre-030: if content_hash isn't a column yet, retry the update without it.
    const srcPatch = { full_text: content, summary: docSummary };
    if (replaceSourceId) srcPatch.content_hash = docHash;
    const { error: updErr } = await db.from('sources')
      .update(srcPatch).eq('id', sourceId).eq('tenant_id', ctx.tenantId);
    if (updErr && isUnknownColumnError(updErr) && 'content_hash' in srcPatch) {
      delete srcPatch.content_hash;
      await db.from('sources').update(srcPatch).eq('id', sourceId).eq('tenant_id', ctx.tenantId);
    }
  } else {
    const { data: source, error: srcErr } = await insertWithOptionalCols(db, 'sources', {
      user_id:      ctx.userId,
      tenant_id:    ctx.tenantId,
      source_type:  'document',
      reference:    filename,
      summary:      docSummary,
      item_count:   0,
      full_text:    content,
      content_hash: docHash,
    }, SOURCE_DOC_COLS);
    if (srcErr) {
      // A concurrent identical upload won the idempotency race (hit the unique
      // (tenant, content_hash) index). Treat it as the duplicate it is.
      if (String(srcErr.code) === '23505') {
        const dup = await findExistingDocument(db, ctx.tenantId, docHash);
        return {
          stored: false, duplicate: true,
          existing_source_id: dup?.id, existing_ingested_at: dup?.ingested_at,
          reference: dup?.reference, message: 'This document is already in your twin.',
        };
      }
      throw sbError('sources.insert', srcErr);
    }
    sourceId = source?.id || null;
  }
  const stored = [];

  if (knowledgeType === 'skill') {
    // Skills are stored as a single whole record so creation-mode retrieval
    // always returns the complete content, not a partial excerpt. The whole
    // record IS the document, so no separate parent summary is created.
    const result = await addKnowledge(ctx, {
      type:                  'skill',
      content,
      title:                 filename,
      source_type:           'document',
      source_ref:            filename,
      precomputed_auto_tags: docAutoTags,
      source_id:             sourceId,
      // No chunk_index: a skill doc is ONE whole record, not a multi-part
      // document. Leaving it null keeps it a normal flat library card (the
      // collapse filter only hides chunk_index >= 1 parts) and never orphans it
      // behind a parent that doesn't exist for skills.
    });
    stored.push(result.id);
  } else {
    // Knowledge documents: chunk (with overlap) for fine-grained retrieval.
    const chunks = chunkText(content, 2500, 100);

    // Parallelize chunks in batches of 8. Sequential batches bound peak
    // concurrency to ~8 simultaneous embed + insert + upsert pipelines.
    const BATCH_SIZE = 8;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((chunk, idx) =>
        addKnowledge(ctx, {
          type:                  'knowledge',
          content:               chunk,
          title:                 chunks.length > 1 ? `${filename}, part ${i + idx + 1}` : filename,
          source_type:           'document',
          source_ref:            filename,
          precomputed_auto_tags: docAutoTags,
          source_id:             sourceId,
          chunk_index:           i + idx + 1,   // 1-based; 0 is reserved for the parent summary
        })
      ));
      for (const r of results) stored.push(r.id);
    }
  }

  // ── Parent summary vector (chunk_index 0) — the whole-document notion that
  // retrieval can match and expand from. Only for chunked (knowledge) docs;
  // a skill doc's single whole record already serves that role.
  let parentId = null;
  if (sourceId && knowledgeType !== 'skill') {
    parentId = await storeParentSummary(ctx, {
      sourceId, summary: docSummary, sourceRef: filename,
      sourceType: 'document', docAutoTags,
    });
  }

  // The new copy is fully written. ONLY NOW remove the previous copy's chunks +
  // vectors (replace path). Doing it here, never earlier, guarantees a mid-write
  // failure above can't leave the document with no good copy.
  if (reusedSource && (oldChildIds.length || oldChildVecs.length)) {
    if (oldChildVecs.length) {
      try { await getNamespace(ctx.tenantId).deleteMany(oldChildVecs); }
      catch (err) { console.error('[mytwin] replace: old vector delete failed:', err.message); }
    }
    if (oldChildIds.length) {
      await db.from('knowledge').delete().eq('tenant_id', ctx.tenantId).in('id', oldChildIds);
    }
  }

  if (sourceId) await db.from('sources').update({ item_count: stored.length }).eq('id', sourceId);

  return {
    stored:      true,
    filename,
    chunks:      stored.length,   // REAL stored chunk count (backs the honest store card)
    source_id:   sourceId,
    document_id: sourceId,
    parent_id:   parentId,
    replaced:    reusedSource,
  };
}

// ── add_reference_record ──────────────────────────────────────────────────────
//
// Captures a creation event: knowledge used + skill applied + output produced +
// the nuance of the case. The record is embedded so `find_patterns` can walk
// across reference records and surface meta-principles. Knowledge + skill IDs
// are encoded as structural tags so we can join back to source items later.

export async function addReferenceRecord(ctx, { title, knowledge_ids, skill_id, output_summary, nuance, tags }) {
  if (typeof output_summary !== 'string' || !output_summary.trim()) {
    throw new UserError('output_summary is required.');
  }
  assertLength('Output summary', output_summary, MAX_KNOWLEDGE_CHARS);
  assertLength('Nuance',         nuance || '',   MAX_KNOWLEDGE_CHARS);
  assertLength('Title',          title  || '',   MAX_TITLE_CHARS);

  // Compose a single embeddable record — markdown-ish, content-only.
  const parts = [];
  if (title)          parts.push(`# ${title}`);
  parts.push('## Output');
  parts.push(output_summary.trim());
  if (nuance && nuance.trim()) {
    parts.push('\n## Nuance');
    parts.push(nuance.trim());
  }
  const content = parts.join('\n\n');

  // Structural tags — let the LLM (and future queries) recover the linked
  // knowledge + skill ids from the reference record itself.
  const structuralTags = [];
  for (const kid of (Array.isArray(knowledge_ids) ? knowledge_ids : [])) {
    if (typeof kid === 'string' && kid) structuralTags.push(`ref-knowledge:${kid}`);
  }
  if (typeof skill_id === 'string' && skill_id) structuralTags.push(`ref-skill:${skill_id}`);

  // Hand off to addKnowledge — same provenance default (personal), same
  // embedding pipeline, same Pinecone metadata enrichment.
  const stored = await addKnowledge(ctx, {
    type:        'reference-record',
    title:       title || null,
    content,
    source_type: 'typed',
    manual_tags: [...(Array.isArray(tags) ? tags : []), ...structuralTags],
    provenance:  'personal',
  });

  return {
    stored:        true,
    id:            stored.id,
    display_ref:   stored.display_ref,
    type:          'reference-record',
    title:         stored.title,
    knowledge_ids: Array.isArray(knowledge_ids) ? knowledge_ids : [],
    skill_id:      skill_id || null,
    tags:          stored.tags,
  };
}

// ── add_voice_note ────────────────────────────────────────────────────────────

export async function addVoiceNote(ctx, { transcript, date, notes }) {
  if (typeof transcript !== 'string' || !transcript.trim()) {
    throw new UserError('Transcript is required.');
  }
  assertLength('Transcript', transcript, MAX_VOICE_NOTE_CHARS);

  const db = getDB();

  const sourceRef = `voice note${date ? ` — ${date}` : ''}`;

  // Retain the raw transcript on the source row (mirrors the notes pattern:
  // raw kept, derived items link back via source_id). No content_hash here:
  // two genuine voice notes can share text, so we keep them exempt from the
  // (tenant, content_hash) idempotency index.
  const { data: source } = await insertWithOptionalCols(db, 'sources', {
    user_id:     ctx.userId,
    tenant_id:   ctx.tenantId,
    source_type: 'voice-note',
    reference:   sourceRef,
    item_count:  0,
    full_text:   transcript,
  }, SOURCE_DOC_COLS);
  const sourceId = source?.id || null;

  const items = await extractFromVoiceNote(transcript);

  if (!items.length) {
    return { stored: false, reason: 'Could not extract structured knowledge from transcript', source_ref: sourceRef };
  }

  const stored = [];
  let idx = 0;
  for (const item of items) {
    const result = await addKnowledge(ctx, {
      type:        item.type || 'principle',
      title:       item.title,
      content:     item.content,
      source_type: 'voice-note',
      source_ref:  sourceRef,
      manual_tags: item.tags || [],
      source_id:   sourceId,
      chunk_index: ++idx,
    });
    stored.push(result);
  }

  if (source) await db.from('sources').update({ item_count: stored.length }).eq('id', source.id);

  return {
    stored: true,
    source_ref: sourceRef,
    items_extracted: stored.length,
    items: stored.map(s => ({ id: s.id, type: s.type, title: s.title })),
  };
}

// ── notes (standalone captures — NEVER embedded, invisible to the twin) ────────
//
// A Note is the opposite of addVoiceNote. addVoiceNote extracts knowledge items
// and embeds them into the twin; addNote writes ONE row to `notes` and never
// calls embed() or Pinecone.upsert(). With no vector, a note can never surface in
// searchTwin / synthesise / find_patterns / concept compilation. That absence is
// the line between a private Note and a live Twin item — capture and commit are
// two separate acts now. Promotion happens elsewhere (confirm-store), on purpose.

const MAX_NOTE_TITLE_CHARS = 200;
const NOTE_SELECT = 'id, title, transcript, mode, duration_ms, promoted_knowledge_id, promoted_at, created_at, updated_at';

// A note needs a glanceable title even when the speaker never gave one. Take the
// first few words of the transcript, trimmed to a sane length.
function deriveNoteTitle(transcript) {
  const firstLine = String(transcript || '').trim().split(/\n/)[0] || '';
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  const t = (words || 'Untitled note').replace(/[.,;:!?]+$/, '');
  return t.length > 80 ? t.slice(0, 79).trimEnd() + '…' : t;
}

// One-line preview for the library list. Never returns the full transcript.
function noteSnippet(transcript, max = 180) {
  const t = String(transcript || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

export async function addNote(ctx, { transcript, title, mode, duration_ms }) {
  if (typeof transcript !== 'string' || !transcript.trim()) {
    throw new UserError('A transcript is required to save a note.');
  }
  assertLength('Transcript', transcript, MAX_VOICE_NOTE_CHARS);
  assertLength('Title',      title,      MAX_NOTE_TITLE_CHARS);
  title = cleanTitle(title);

  const db  = getDB();
  const dur = Number(duration_ms);

  const { data, error } = await db
    .from('notes')
    .insert({
      user_id:     ctx.userId,
      tenant_id:   ctx.tenantId,
      title:       (title && title.trim()) ? title.trim() : deriveNoteTitle(transcript),
      transcript:  transcript.trim(),
      mode:        mode === 'meeting' ? 'meeting' : 'quick',
      duration_ms: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
    })
    .select(NOTE_SELECT)
    .single();

  if (error) throw sbError('notes.insert', error);
  return { ...data, snippet: noteSnippet(data.transcript) };
}

export async function listNotes(ctx, { limit = 200 } = {}) {
  const db = getDB();
  const { data, error } = await db
    .from('notes')
    .select(NOTE_SELECT)
    .eq('user_id',   ctx.userId)
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 200, 500));

  if (error) throw sbError('notes.list', error);
  return (data || []).map(n => ({ ...n, snippet: noteSnippet(n.transcript) }));
}

export async function getNote(ctx, id) {
  const db = getDB();
  const { data, error } = await db
    .from('notes')
    .select(NOTE_SELECT)
    .eq('id',        id)
    .eq('user_id',   ctx.userId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;   // no rows / not the caller's
    throw sbError('notes.get', error);
  }
  return data;
}

// Handles rename, transcript edit, and the promote marker. Each field is
// optional; only what's supplied is written. Always touches updated_at.
export async function updateNote(ctx, id, { title, transcript, promoted_knowledge_id } = {}) {
  const db = getDB();
  const patch = { updated_at: new Date().toISOString() };

  if (typeof title === 'string') {
    assertLength('Title', title, MAX_NOTE_TITLE_CHARS);
    patch.title = title.trim() || deriveNoteTitle(transcript || '');
  }
  if (typeof transcript === 'string') {
    if (!transcript.trim()) throw new UserError('A note cannot have an empty transcript.');
    assertLength('Transcript', transcript, MAX_VOICE_NOTE_CHARS);
    patch.transcript = transcript.trim();
  }
  if (typeof promoted_knowledge_id === 'string' && promoted_knowledge_id) {
    patch.promoted_knowledge_id = promoted_knowledge_id;
    patch.promoted_at           = new Date().toISOString();
  }

  const { data, error } = await db
    .from('notes')
    .update(patch)
    .eq('id',        id)
    .eq('user_id',   ctx.userId)
    .eq('tenant_id', ctx.tenantId)
    .select(NOTE_SELECT)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw sbError('notes.update', error);
  }
  return { ...data, snippet: noteSnippet(data.transcript) };
}

export async function deleteNote(ctx, id) {
  const db = getDB();
  const { error, count } = await db
    .from('notes')
    .delete({ count: 'exact' })
    .eq('id',        id)
    .eq('user_id',   ctx.userId)
    .eq('tenant_id', ctx.tenantId);

  if (error) throw sbError('notes.delete', error);
  return { deleted: (count ?? 0) > 0 };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, '\n\n').trim();
}

// Split text into overlapping chunks on paragraph boundaries. `size` is the soft
// char budget per chunk; `overlap` carries a tail of the just-flushed chunk into
// the next, so meaning is preserved across a boundary (a point split mid-thought
// still appears whole in one of the two chunks). Previously `overlap` was dead —
// declared but never applied; this implements it.
export function chunkText(text, size = 2500, overlap = 100) {
  const paragraphs = String(text || '').split(/\n{2,}/);
  const chunks = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); };

  for (const p of paragraphs) {
    // A single paragraph larger than the budget is hard-split into overlapping
    // slices so one chunk never blows past the embedding input window.
    if (p.length > size) {
      flush(); current = '';
      const step = Math.max(1, size - overlap);
      for (let i = 0; i < p.length; i += step) {
        const piece = p.slice(i, i + size).trim();
        if (piece) chunks.push(piece);
      }
      continue;
    }
    if (current && (current + '\n\n' + p).length > size) {
      flush();
      const tail = overlap > 0 ? tailWords(current, overlap) : '';
      current = tail ? tail + '\n\n' + p : p;
    } else {
      current += (current ? '\n\n' : '') + p;
    }
  }
  flush();
  return chunks.length ? chunks : [String(text || '').slice(0, size)];
}

// Roughly the last `maxChars` of a chunk, started at a word boundary so the
// carried-over tail reads cleanly rather than mid-word.
function tailWords(s, maxChars) {
  if (maxChars <= 0 || s.length <= maxChars) return s.trim();
  const t = s.slice(-maxChars);
  const sp = t.indexOf(' ');
  return (sp > 0 ? t.slice(sp + 1) : t).trim();
}
