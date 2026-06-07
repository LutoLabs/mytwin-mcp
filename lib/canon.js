// lib/canon.js
// Single source of truth for the Eleusis canon seed — the twin's own
// self-knowledge and worldview. See schema/migrations/027-canon-provenance.sql
// and the "Eleusis Canon Seed" build brief.
//
// Imported by retrieval (tools/retrieval.js) for the constants, and by the
// loader (scripts/load-canon.mjs) for the item definitions + content reader.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Identity ──────────────────────────────────────────────────────────────────
// Fixed UUIDs, mirrored in migration 027. Canon rows are owned by this system
// tenant/user, which isolates them from every (user_id, tenant_id)-scoped query
// (welcome counts, hypergraph, library, find_patterns, compilation, edit/delete).
export const CANON_TENANT_ID = 'e1e051c0-0000-4000-8000-000000000001';
export const CANON_USER_ID   = 'e1e051c0-0000-4000-8000-000000000002';

// The internal provenance value — stored in the DB column and Pinecone metadata.
export const CANON_PROVENANCE = 'canon';

// The shared Pinecone namespace every tenant's retrieval also searches.
export const CANON_NAMESPACE = 'canon';

// Display label shown in the context block, citations, and UI. The product name
// is still open: rename HERE only. Never write this string into the database —
// the stable internal key 'canon' is what persists, so a rename is a one-line
// change, not a data migration.
export const CANON_DISPLAY_LABEL = 'Eleusis';

// ── Retrieval tuning ──────────────────────────────────────────────────────────
// Canon should surface when the turn is about the twin, the product, how it
// works, or its worldview — and stay quiet otherwise. The score floor enforces
// "quiet otherwise"; the hit cap guarantees canon can never crowd out the user's
// own material. Both are deliberately conservative and easy to tune.
export const CANON_QUERY_TOP_K = 4;     // canon vectors pulled per query
// Cosine floor below which canon is dropped. Calibrated against text-embedding-
// 3-small (scripts/_verify-canon.mjs): on-topic "how do you work" phrasings land
// ~0.25-0.31, clearly off-topic turns ~0.05, so 0.20 sits in the gap — it admits
// genuine twin/product/worldview questions and stays quiet on unrelated ones.
export const CANON_MIN_SCORE   = 0.20;
export const CANON_MAX_HITS    = 2;     // max canon items admitted to one result set

// ── The seed items ────────────────────────────────────────────────────────────
// Split into two so retrieval can surface the relevant slice: operational
// self-knowledge (what the twin is / can do) vs the worldview (the thesis).
// Stable ids make the loader idempotent — a re-run upserts the same rows and
// vectors rather than duplicating. Bodies live in files under schema/canon/ so
// updating the seed is one edit + one `node scripts/load-canon.mjs` command,
// received by every account on its next session (one shared copy, no backfill).
export const CANON_ITEMS = [
  {
    id:          'e1e051c0-0000-4000-8000-0000000000a1',
    pinecone_id: 'canon-self-knowledge-v1',
    type:        'knowledge',
    title:       'What this twin is and what it can do',
    file:        'self-knowledge.md',
  },
  {
    id:          'e1e051c0-0000-4000-8000-0000000000a2',
    pinecone_id: 'canon-worldview-v1',
    type:        'principle',
    title:       'Worldview and thesis',
    file:        'worldview.md',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const _contentDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'canon');

// Read a canon item's body from its content file. Lazy on purpose: importing the
// constants in retrieval must never touch the filesystem. Only the loader calls
// this.
export function readCanonContent(item) {
  return readFileSync(join(_contentDir, item.file), 'utf8').trim();
}

// True when an item / row / Pinecone match carries canon provenance.
export function isCanon(x) {
  return (x?.provenance ?? x?.metadata?.provenance) === CANON_PROVENANCE;
}
