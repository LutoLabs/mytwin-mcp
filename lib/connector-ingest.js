// The connector ingest path: normalise a remote item to text, then route it
// through the existing document pipeline (addDocument → chunk → embed → Pinecone)
// while keeping the (provider, external_id) -> source_id map in sync.
//
// This is what makes sync idempotent across re-delivery AND edits:
//   * first pull        → addDocument creates a source, map row records it
//   * webhook re-fire   → same external_id, same content hash → no-op
//   * edited transcript → same external_id, NEW hash → REPLACE the same source
//                         in place (replaceSourceId) instead of duplicating
//   * content backstop  → if a byte-identical doc already exists under a
//                         different id, link to it rather than store twice
//
// Content-hash (sources.content_hash, migration 030) is the secondary backstop;
// the native-id map is the primary key for sync.

import { addDocument } from '../tools/storage.js';
import { hashDocument } from './content-hash.js';
import { getMapping, upsertMapping } from './connections.js';

/**
 * Ingest one normalised connector item idempotently.
 *
 * @param {{tenantId:string,userId:string}} ctx
 * @param {object} item
 * @param {string} item.connectionId
 * @param {string} item.provider          'fireflies' | ...
 * @param {string} item.externalId        provider-native id (idempotency key)
 * @param {string} item.title             document title/filename
 * @param {string} item.content           normalised plain text
 * @param {string} [item.summary]         one-line summary for the parent record
 * @param {string} [item.externalUpdatedAt] provider's last-edited timestamp (ISO)
 * @returns {Promise<{status:string, source_id:string|null, external_id:string, title:string}>}
 *          status ∈ created | updated | unchanged | linked-existing | skipped-empty
 */
export async function ingestConnectorItem(ctx, {
  connectionId, provider, externalId, title, content, summary, externalUpdatedAt,
}) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    return { status: 'skipped-empty', source_id: null, external_id: externalId, title };
  }

  const newHash = hashDocument(text, ctx.tenantId);
  const mapping = await getMapping(ctx.tenantId, provider, externalId);

  // Already ingested and unchanged — the common case for a re-delivered webhook
  // or a backstop poll. Cheapest possible exit: no embed, no write.
  if (mapping && mapping.source_id && mapping.content_hash === newHash) {
    return { status: 'unchanged', source_id: mapping.source_id, external_id: externalId, title };
  }

  let sourceId = null;
  let status;

  if (mapping && mapping.source_id) {
    // Known item, changed content → replace the SAME source in place.
    const res = await addDocument(ctx, {
      filename: title, content: text, summary, replaceSourceId: mapping.source_id,
    });
    sourceId = res.source_id || mapping.source_id;
    status = 'updated';
  } else {
    // New item (or its source was deleted) → create. addDocument's own
    // content-hash idempotency catches a byte-identical doc stored elsewhere.
    const res = await addDocument(ctx, { filename: title, content: text, summary });
    if (res && res.duplicate) {
      sourceId = res.existing_source_id || null;
      status = 'linked-existing';
    } else {
      sourceId = res.source_id || null;
      status = 'created';
    }
  }

  await upsertMapping(ctx, {
    connectionId, provider, externalId, sourceId,
    contentHash: newHash, externalUpdatedAt: externalUpdatedAt || null,
  });

  return { status, source_id: sourceId, external_id: externalId, title };
}
