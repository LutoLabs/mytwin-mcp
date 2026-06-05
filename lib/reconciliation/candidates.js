// Reconciliation Stage 2 — candidate retrieval.
//
// Reuses the existing per-tenant Pinecone namespace (the SAME index the twin
// already embeds into) + the knowledge table. Returns the nearest EXISTING
// items to a fragment, each with its cosine score, excluding the fragment
// itself and any non-active (superseded/merged) item. No new vector infra.

import { embed }        from '../embed.js';
import { getNamespace } from '../pinecone.js';
import { getDB }        from '../supabase.js';
import { RECON_CONFIG } from './config.js';

// Retrieve top-K nearest active items to `embedding`, hydrated from the DB.
export async function getRawCandidates({ tenantId, embedding, topK = RECON_CONFIG.candidateTopK, excludeItemId }) {
  const ns = getNamespace(tenantId);
  const res = await ns.query({
    vector: embedding,
    topK: topK + 1,            // +1 to absorb the fragment's self-match
    includeMetadata: true,
  });

  const matches = (res.matches || [])
    .filter(m => m.metadata?.knowledge_id && m.metadata.knowledge_id !== excludeItemId);
  if (!matches.length) return [];

  // Hydrate candidate rows (active only) and keep the similarity score.
  const ids = matches.map(m => m.metadata.knowledge_id);
  const db  = getDB();
  const { data: rows } = await db.from('knowledge')
    .select('id, type, title, content, status, updated_at, created_at')
    .in('id', ids);
  const byId = new Map((rows || []).map(r => [r.id, r]));

  const out = [];
  for (const m of matches) {
    const row = byId.get(m.metadata.knowledge_id);
    if (!row) continue;
    if (row.status && row.status !== 'active') continue;   // never reconcile against superseded/merged
    out.push({ ...row, score: m.score });
    if (out.length >= topK) break;
  }
  return out;
}

// Convenience: embed text, then retrieve candidates (used by the eval harness).
export async function candidatesForText({ tenantId, text, excludeItemId }) {
  const embedding = await embed(text);
  return getRawCandidates({ tenantId, embedding, excludeItemId });
}
