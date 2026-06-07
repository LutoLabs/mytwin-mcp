# Document Ingestion — Current-State Recon

**Date:** 2026-06-07 · **Scope:** read-only. Nothing changed.
**Purpose:** establish exactly what exists before drafting the two-layer (raw source-of-truth +
derived summary/chunks) build, so we extend rather than reinvent.
**Method:** code reads + live prod schema/row introspection (service-role, read-only).

---

## TL;DR

The "two-layer" model is **~30% already present, loosely.** There is a real per-ingest grouping
row (`sources`), a real chunk pipeline, and one genuine raw-source-of-truth precedent (`notes`).
But the link between a chunk and its source is a **string match (`source_ref` = filename), not a
durable id**; the **raw document is never stored as a unit** for knowledge-type uploads; there is
**no blob storage at all**; chunking has **no overlap** (the param is dead code); and there is **no
content-hash / idempotency** anywhere in ingest. The store-card "1 complete document · N retrievable
pieces" is **cosmetic** — no such complete-document entity exists, and N is an LLM estimate, not the
real chunk count. **Extend `sources` into a `documents` parent + add `document_id`/`chunk_index`;
don't rebuild the pipeline.**

---

## 1. Schema

**`knowledge` columns (live prod, 20):**
`id, user_id, type, title, content, source_type, source_ref, tags, pinecone_id, created_at,
updated_at, tenant_id, provenance, version_number, is_living_document, visibility, workspace_id,
status, superseded_by, merged_into`

Base table ([schema/v2.sql](schema/v2.sql)):
```sql
create table if not exists knowledge (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null, title text, content text not null,
  source_type text,   -- 'typed', 'voice-note', 'document', 'url'
  source_ref  text,
  tags text[], pinecone_id text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
```
Columns added later: `tenant_id` (001), `provenance` (005/016), `version_number` +
`is_living_document` (013_versioning), `visibility` (014), `workspace_id` (018),
`status` + `superseded_by` + `merged_into` (025-reconciliation).

**Existing document/source grouping — what's there:**
- **`source_ref` (text)** — the de-facto grouping key (filename / URL / voice-note label). It is a
  **string, not an id.** All chunks of one upload share the same `source_ref`.
- **`source_type` (text)** — `'typed' | 'document' | 'url' | 'voice-note'`.
- **`sources` table** — one row **per ingest event** ([schema/v2.sql](schema/v2.sql)):
  ```sql
  create table if not exists sources (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    source_type text not null,   -- 'document', 'url', 'voice-note'
    reference text not null, summary text, item_count integer default 0,
    ingested_at timestamptz default now()
  );
  ```
  **58 rows live.** But **`knowledge` has no `source_id` FK to it** — the only link is
  `(source_type, reference == source_ref)` by string. So the parent exists but the child→parent
  edge is not durable.

**What does NOT exist anywhere in schema:** `document_id`, `chunk_index`, `parent_id`, a `part`
field, or a `documents` table. (`superseded_by` / `merged_into` link knowledge→knowledge for the
**living-document/reconciliation** feature — not for chunk grouping; do not conflate.)

---

## 2. Ingest path

**Extraction is BROWSER-side, not server-side.** [public/twin.html](public/twin.html) lazy-loads
`pdf.js` (pdfjs-dist@3.11.174) and `mammoth@1.6.0` from CDN, extracts `.pdf`/`.docx`/`.txt`/`.md` to
**plain text in the browser** (twin.html:2552-2570), then POSTs `{filename, content}` to the server.
**The original binary never reaches the server.**

Flow: `POST /api/twin/document-propose` (LLM preview, **persists nothing**) → user confirms →
`POST /api/twin/document.js` → `addDocument(ctx, {filename, content, type})`
([api/twin/document.js:39](api/twin/document.js:39)).

**Chunking** ([tools/storage.js:310](tools/storage.js:310), [chunkText:585](tools/storage.js:585)):
- `chunkText(content, 2500, 100)` — splits on blank lines (`/\n{2,}/`), greedily accumulates whole
  paragraphs until length > **2500 chars**, then flushes. Paragraph-boundary, char-budget splitter
  (not token- or sentence-aware).
- ⚠️ **The `overlap` param (100) is declared but never used** — `chunkText` ignores it. **There is
  zero overlap between chunks today.**
- `type: 'skill'` bypasses chunking and stores the whole document as ONE record (raw retained).

**"part N" title** ([storage.js:321](tools/storage.js:321)): `` `${filename}, part ${i+idx+1}` ``
when `chunks.length > 1`, from the loop index. It is **only a title string** — there is no
`chunk_index` column.

**Is the full extracted text retained?** **No (for knowledge-type).** Each chunk becomes its own
`knowledge` row; `sources` stores only `{reference, summary?, item_count}` — **not the text.** The
raw document is effectively discarded after chunking (loosely reconstructable by concatenating chunk
rows only because there's no overlap, but there is no canonical raw object). **For `skill`-type the
whole text survives as the single `content`** — the one place "raw" is currently kept intact.

---

## 3. Blob storage

**None.** `grep` for `storage.from(` / `.bucket(` / `.upload(` / Supabase Storage across
`api/ lib/ tools/ public/` returns **nothing**. Everything is **Postgres (Supabase) + Pinecone
only.** Supabase Storage is available via the installed SDK but is **not configured or used.**

→ For "raw document as source of truth," there is currently **no substrate for the raw bytes or the
full extracted text.** This is net-new: either retain full extracted text in a `documents` table
(Postgres) and/or stand up Supabase Storage for the original binary.

---

## 4. The store-proposal card

Copy ([public/twin.html:2753-2757](public/twin.html:2753)):
```js
// "1 complete document · N retrievable pieces"
`1 complete document · ${proposal.estimated_blocks || 1} retrievable
 ${proposal.estimated_blocks === 1 ? 'piece' : 'pieces'}`
```
- **`estimated_blocks` is an LLM estimate** produced at propose-time
  ([api/twin/document-propose.js:28](api/twin/document-propose.js:28)): *"integer estimate of how
  many distinct meaningful pieces… round to a sensible number (1, 3, 5, 8, 12, 20)."* It is **not the
  real chunk count** — actual chunks come from `chunkText`'s 2500-char budget, computed later and
  independently. The card's number and the stored count can differ.
- **"1 complete document" has no durable entity behind it** for knowledge uploads (chunked, raw
  discarded). There are **no "links to part 1…N"** in the data model — just shared `source_ref` +
  per-chunk "part N" titles.

**Verdict: cosmetic per-ingest text. No durable parent, no links.** The nearest real artifacts are
the loose `sources` row (no FK) and the "part N" titles. This is exactly the gap the two-layer model
should close.

---

## 5. Retrieval (tools/retrieval.js)

`searchTwin(ctx, { query, top_k=10, type })` → **`{ results: [...], query, count }`**; `top_k` hard-
capped to `MAX_SEARCH_RESULTS`. Queries own + shared + workspace + canon namespaces in parallel,
merges, ranks, fetches rows, returns **summary-only** items.

Each result item ([retrieval.js:203-215](tools/retrieval.js:203)):
```
{ id, type, title, summary: oneLineSummary(content), tags(≤8),
  source_type, source_ref, date, relevance: round(score*100),
  shared?, access_level?, workspace?, workspace_id?, canon? }
```
(Full content is NOT returned — only a one-line summary; drill-in via `list_recent`/`get_by_*`.)

**Pinecone metadata carried on each match:** `knowledge_id, user_id, tenant_id, type,
knowledge_type, provenance, source_type, source_ref, created_at`.

**Dedupe today** ([rankDedupeMatches:102-114](tools/retrieval.js:102)): **by `knowledge_id` only.**
Two rows with **identical content** but different ids are **both** returned — common with
near-duplicate chunks or the same doc re-uploaded.

**Where the new behaviours slot in:**
- **Identical-content dedupe** → in `rankDedupeMatches`. It only sees *metadata* at rank time, so the
  clean approach is to **write a `content_hash` into vector metadata at ingest** and add it to the
  `seen` set (or dedupe post-`rowMap` on normalized content). One function, one new metadata field.
- **Parent-summary-plus-expand** → between `rankDedupeMatches` and the item map (lines 151-217).
  Group sibling chunks by a new `document_id`, collapse them into **one parent result carrying the
  stored document summary**, and add a `get_document(document_id)` expand tool. There is **no parent
  notion today** — results are flat "part N" chunks — so this is additive, not a rewrite.

---

## 6. Vectors & embeddings

- **Namespace-per-tenant: confirmed.** `tenant_${tenantId}` ([lib/pinecone.js:88-94](lib/pinecone.js:88));
  `getNamespace` throws if `tenantId` is missing (no unscoped access). Plus a shared `canon`
  namespace. Index: `PINECONE_INDEX_NAME` (default `mytwin`), **dim 1536, cosine, serverless aws
  us-east-1**.
- **Metadata stored on each vector** (addKnowledge upsert, [storage.js:185-195](tools/storage.js:185)):
  `knowledge_id, user_id, tenant_id, type, knowledge_type, provenance, source_type, source_ref,
  created_at`. (The wrapper force-fills `knowledge_type`.)
- **Can we add `document_id` + `chunk_index`?** **Yes, trivially.** Pinecone metadata is schemaless —
  just add the fields to the upsert `metadata` object; no Pinecone migration, and `$eq`/`$in`
  filtering on them works immediately. (Mirror them as real columns on `knowledge` for SQL joins.)
- **Embedding model:** `text-embedding-3-small`, **input truncated to 8000 chars**, 1536-dim
  ([lib/embed.js:25-31](lib/embed.js:25)). A reprocess-from-source path is concrete: re-run
  `chunkText(rawText)` → `embed()` with the same model into the same namespace.

---

## 7. Other captures & conventions

**The pattern already generalises.** All three rich captures do the same thing — *a `sources` row +
N `knowledge` items linked by `source_ref` string*:
- **Voice notes** ([addVoiceNote:395](tools/storage.js:395)): `extractFromVoiceNote` (gpt-4o-mini) →
  N items → `sources` row (`voice-note`) + N `addKnowledge` (`source_ref = "voice note — <date>"`).
  **Full transcript not retained** in `knowledge`.
- **URL captures** ([addFromUrl:213](tools/storage.js:213)): fetch + `stripHtml` → `analyseUrl`
  (gpt-4o-mini, ≤5 items) → `sources` row (`url`) + N `addKnowledge` (`source_ref = url`). **Full
  page text not retained.**
- **Notes** ([addNote:465](tools/storage.js:465)) — **the existing raw-source-of-truth precedent:**
  one `notes` row holds the **full transcript**, is **never embedded**, and carries
  `promoted_knowledge_id` to link to a derived knowledge item when promoted. This is conceptually the
  two-layer model already, for one capture type — worth mirroring.

**Live `source_type` distribution in `knowledge`:** `typed 442, document 173, voice-note 55, url 5,
voice-capture 1, canon 2` (670 total). So **173 document chunks** map back to only **58 `sources`
rows** (all capture types) — the grouping data is sparse and string-linked.

**Latest migration / convention:** **`029-public-links.sql`** is newest. Convention: 3-digit
zero-padded, hyphen-separated kebab — `NNN-name.sql`. (Legacy ≤015 used an underscore: `0NN_name.sql`.)
The doc-model migration would be **030-…**.

**Content-hash / idempotency in ingest:** **None.** `pinecone_id = k-${Date.now()}-${random}`
([storage.js:117](tools/storage.js:117)); no hashing, no dedupe, no idempotency key on any ingest
path. **Re-uploading the same file creates a fresh `sources` row + a full set of duplicate chunks.**
(All `createHash`/SHA-256 in the repo is auth/oauth tokens; the "idempotent" comments elsewhere are
logical upserts on natural keys — canon stable ids, sharing on `(email,item)` — not ingest.)

---

## Already partly built → EXTEND, don't replace

| Existing | Extend into |
|---|---|
| **`sources` table** (per-ingest, has `summary`, `item_count`) | The `documents` **parent** — add raw full-text (or a Storage pointer), `content_hash`, and use its `id` as the durable `document_id` FK on `knowledge`. |
| **`source_ref` string link** | Replace as the grouping key with a real `document_id` FK + `chunk_index` (keep `source_ref` for display). |
| **`notes` table** (full transcript, never embedded, `promoted_knowledge_id`) | The proven raw→derived precedent — model `documents`→`knowledge` the same way. |
| **addKnowledge upsert metadata** | Add `document_id` + `chunk_index` (Pinecone + columns) — one-line change, no migration for Pinecone. |
| **`document-propose` → `document` confirm flow** | The natural place to compute the real chunk plan, persist the raw doc, and write a `content_hash` for idempotency (dedupe on re-upload). |
| **`skill`-type whole-doc storage** | "Raw retained" already works for skills — generalise it to all docs as the source-of-truth layer. |
| **`chunkText`** | Fix the dead `overlap` param (currently no overlap) when you formalise chunking. |
| **Living-doc fields** (`version_number`, `is_living_document`, `superseded_by`, `merged_into`, `status`) | Independent feature — ensure the doc model **coexists** with it; don't reuse these for chunk parentage. |

## Two decisions the build brief must make (open today)
1. **Where the raw lives:** full extracted **text in a `documents` table** (simplest, all-Postgres) vs.
   **original binary in Supabase Storage** (truer source of truth, new infra). Today: neither exists.
2. **Idempotency key:** `content_hash` of raw text (+ tenant) to make re-upload a no-op/version, since
   there is zero dedupe today.
