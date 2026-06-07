// POST /api/twin/document-propose
//
// User uploads a document → frontend reads the text → POSTs here → we use
// Haiku to generate a record preview (title, knowledge_type, tags, summary,
// estimated extraction count) and a Pinecone similarity search for connections
// to existing items. Frontend renders the preview as a proposal card; user
// confirms or cancels. Storage happens only via POST /api/twin/document
// after explicit confirmation.
//
// This fixes the v1 regression where file uploads stored silently with the
// robotic "Stored X as 10 chunks" message. Spec §3.2.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { callFastJson } from '../../lib/anthropic.js';
import { embed } from '../../lib/embed.js';
import { getNamespace } from '../../lib/pinecone.js';
import { getDB } from '../../lib/supabase.js';
import { chunkText } from '../../tools/storage.js';
import { hashDocument } from '../../lib/content-hash.js';

// Idempotency preview: has this exact document (same tenant) already been
// ingested? Returns minimal metadata so the proposal card can offer "already in
// your twin, replace it?". Resilient: pre-030 (no content_hash column) or any
// error returns null, so the preview simply doesn't show — confirm-time still
// enforces idempotency.
async function lookupExistingDocument(tenantId, contentHash) {
  if (!contentHash) return null;
  try {
    const { data, error } = await getDB()
      .from('sources')
      .select('id, reference, ingested_at')
      .eq('tenant_id', tenantId).eq('content_hash', contentHash)
      .order('ingested_at', { ascending: true }).limit(1).maybeSingle();
    if (error) return null;
    return data ? { source_id: data.id, reference: data.reference, ingested_at: data.ingested_at } : null;
  } catch { return null; }
}

const SYSTEM_PROMPT = `You are previewing a document the user just uploaded to MyAITwin. Build a structured record preview so they can confirm or cancel before anything is stored.

Output JSON:
- title: a short descriptive title for the document, 3-7 words. Pull from the document's actual substance — not the filename.
- type: usually "document". Use a more specific type ("transcript", "essay", "notes", "reference") only if it's clearly that.
- knowledge_type: classify as "skill" if the document is primarily a reusable process, template, writing guide, voice framework, how-to steps, stylistic patterns, or creative structure the person can apply. Classify as "knowledge" for everything else: information, facts, beliefs, research, context, analysis, meeting notes, articles. When in doubt, default to "knowledge".
- tags: 3-6 SEMANTIC tags drawn from the document's actual themes. Never include "document", "upload", "file" or other meta words. Never single-word filler.
- provenance: "personal" (the user's own writing), "organisational" (from their team/company), or "external" (an article, report, third-party document). Infer from content cues — references to "we" or "I" lean personal/organisational; cited authors and academic phrasing lean external.
- summary: ONE sentence describing what the document is and what it's useful for. 12-22 words.
- estimated_blocks: integer estimate of how many distinct meaningful pieces are inside the document (principles, decisions, examples). Round to a sensible number (1, 3, 5, 8, 12, 20). Documents under ~300 chars are usually 1 block. Longer documents with multiple sections may be 5-15+ blocks.

VOICE for any prose you generate: short sentences, no em dashes, no markdown.`;

const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    title:            { type: 'string' },
    type:             { type: 'string' },
    knowledge_type:   { type: 'string', enum: ['knowledge', 'skill'] },
    tags:             { type: 'array', items: { type: 'string' } },
    provenance:       { type: 'string', enum: ['personal', 'organisational', 'external'] },
    summary:          { type: 'string' },
    estimated_blocks: { type: 'integer' },
  },
  required: ['title', 'type', 'knowledge_type', 'tags', 'provenance', 'summary', 'estimated_blocks'],
  additionalProperties: false,
};

// Same stopword guard as the typed-content classifier — don't tag with the
// filename's own filler.
const TAG_STOPWORDS = new Set([
  'document', 'documents', 'doc', 'file', 'upload', 'pdf', 'docx', 'txt', 'md',
  'untagged', 'the', 'a', 'an', 'and', 'or', 'this', 'that',
]);

function cleanTags(rawTags, filename) {
  if (!Array.isArray(rawTags) || !rawTags.length) return ['untagged'];
  // Strip filename-derived tokens — those are upload mechanics, not substance.
  const fileTokens = new Set(
    (filename || '').toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')   // drop extension
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
  const cleaned = rawTags
    .map(t => String(t).toLowerCase().trim())
    .filter(t => t && t.length >= 3)
    .filter(t => !TAG_STOPWORDS.has(t))
    .filter(t => !fileTokens.has(t));
  return cleaned.length ? Array.from(new Set(cleaned)).slice(0, 6) : ['untagged'];
}

// Filename-based skill signal — if the filename explicitly mentions "skill"
// or "skills" the user has already told us what this is.
function hasSkillSignal(filename) {
  const lower = (filename || '').toLowerCase();
  // Ends with -skill.md, _skill.md, -skills.md, _skills.md
  if (/[-_]skills?(?:\.[a-z0-9]+)?$/.test(lower)) return true;
  // Contains the word "skill" or "skills" as a standalone token
  if (/(?:^|[-_.\s])skills?(?:$|[-_.\s.])/.test(lower)) return true;
  return false;
}

// Search for existing twin items that are semantically similar to the incoming
// document. Run in parallel with the LLM classifier — non-critical; failures
// return an empty array so they never block the proposal.
async function findConnections(ctx, content) {
  try {
    const sample = content.slice(0, 2000);
    const vector = await embed(sample);
    const matches = await getNamespace(ctx.tenantId).query({
      vector,
      topK:             5,
      includeMetadata:  true,
    });
    // Only surface confident connections (≥ 50% cosine similarity)
    const strong = (matches.matches || []).filter(m => (m.score || 0) >= 0.5);
    if (!strong.length) return [];
    const ids = [...new Set(strong.map(m => m.metadata?.knowledge_id).filter(Boolean))];
    const { data: rows } = await getDB()
      .from('knowledge')
      .select('id, title')
      .eq('user_id',   ctx.userId)
      .eq('tenant_id', ctx.tenantId)
      .in('id', ids)
      .limit(3);
    return (rows || []).map(r => r.title).filter(Boolean).slice(0, 3);
  } catch {
    // Non-critical — a failed connection search never blocks the proposal
    return [];
  }
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { filename, content } = req.body || {};
  if (typeof filename !== 'string' || !filename.trim()) {
    return res.status(400).json({ error: 'filename is required' });
  }
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  return runTwin(req, res, {
    toolName: 'document_propose',
    fn: async (ctx) => {
      // Truncate the content sample to keep Haiku input small and cheap.
      // The classifier doesn't need the whole document to read its substance.
      const sample = content.length > 4000
        ? content.slice(0, 2500) + '\n\n[...mid-document truncated...]\n\n' + content.slice(-1500)
        : content;

      const userBlock = [
        `FILENAME: ${filename}`,
        `CHAR_COUNT: ${content.length}`,
        '',
        '<document>',
        sample,
        '</document>',
        '',
        'Generate the preview JSON.',
      ].join('\n');

      // Run LLM classification and connection search concurrently — they are
      // independent and the embedding call (~100 ms) overlaps nicely with Haiku.
      const [{ data }, connections] = await Promise.all([
        callFastJson({
          system:    SYSTEM_PROMPT,
          messages:  [{ role: 'user', content: userBlock }],
          schema:    PROPOSE_SCHEMA,
          maxTokens: 600,
        }),
        findConnections(ctx, content),
      ]);

      // Filename signal overrides LLM — the word "skill" in the name is
      // an explicit user intent that trumps content analysis.
      const llmType       = data.knowledge_type === 'skill' ? 'skill' : 'knowledge';
      const knowledge_type = hasSkillSignal(filename) ? 'skill' : llmType;

      // Real chunk plan — the honest count the store card shows, NOT the LLM
      // estimate. Deterministic and cheap (no LLM); mirrors addDocument exactly.
      const chunk_count = knowledge_type === 'skill'
        ? 1
        : chunkText(content, 2500, 100).length;

      // Idempotency preview: is this exact document already in the twin?
      const content_hash  = hashDocument(content, ctx.tenantId);
      const already_exists = await lookupExistingDocument(ctx.tenantId, content_hash);

      return {
        kind: 'document-proposal',
        proposal: {
          title:            data.title,
          type:             data.type || 'document',
          knowledge_type,
          tags:             cleanTags(data.tags, filename),
          provenance:       data.provenance || 'personal',
          summary:          data.summary,
          estimated_blocks: data.estimated_blocks || 1,
          chunk_count,                 // real stored-part count (honest store card)
          content_hash,                // lets confirm reuse without recompute
          ...(already_exists ? { already_exists } : {}),
          connections,
          // The whole content is sent through so confirm-document can store
          // without a second round-trip. It's not user-visible (only the
          // summary + tags + title preview show in the card).
          content,
          filename,
        },
      };
    },
  });
}
