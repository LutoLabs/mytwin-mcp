# Two-Layer Document Ingestion — Build Log & Handoff

**Date:** 2026-06-07 · **Status:** Phases 0–2 code complete + verified; Phase 3 dry-run
delivered (destructive collapse gated). **Migration 030 written, NOT applied.**

Built against the recon ground truth in [DOC_INGESTION_RECON.md](DOC_INGESTION_RECON.md).
Decisions honoured: raw lives as `sources.full_text` in Postgres (no blob infra); idempotency =
`content_hash` of normalised text + tenant; document model kept separate from living-document fields.

---

## What shipped, by phase

### Phase 0 — content-hash chunk dedupe (no migration; ships immediately)
- **[lib/content-hash.js](lib/content-hash.js)** (new): `normalizeText`, `hashChunk(text)`,
  `hashDocument(text, tenant)`. Whitespace normalised before hashing.
- **[tools/storage.js](tools/storage.js)** `addKnowledge`: every chunk now writes `content_hash`
  into **Pinecone vector metadata** (schemaless — works pre-030) and into the knowledge row
  (resilient — populated once 030 lands).
- **[tools/retrieval.js](tools/retrieval.js)** `rankDedupeMatches`: dedupes by `content_hash` as
  well as `knowledge_id`. Plus a **post-fetch content dedupe** in `searchTwin` that computes
  `hashChunk(row.content)` on the fly — so **identical existing chunks collapse to one immediately,
  with no backfill required.**
- **Acceptance ✅** — a query that returned the same part three times now returns it once
  (satisfied for existing data the moment this deploys, via the post-fetch pass).

### Phase 1 — document parent + idempotency
- **[schema/migrations/030-document-model.sql](schema/migrations/030-document-model.sql)** (new):
  `sources.full_text`, `sources.content_hash` + partial unique index `(tenant_id, content_hash)`;
  `knowledge.source_id` (FK→sources), `knowledge.chunk_index`, `knowledge.content_hash` + indexes.
  Additive, reversible, separate from living-doc fields.
- **`addDocument`**: stores the **raw full text** on the `sources` parent, computes the document
  `content_hash`, writes each chunk with a **real `chunk_index`** and `source_id` FK. **Idempotency:**
  on re-upload it finds the existing document and returns a `duplicate` signal instead of storing;
  with `replace: true` it tears down the prior copy (`deleteDocument`) first. Never silently
  duplicates. Returns the **real** chunk count.
- **[api/twin/document-propose.js](api/twin/document-propose.js)**: returns the **real `chunk_count`**
  (deterministic `chunkText`, not the LLM `estimated_blocks`) and an `already_exists` preview.
- **[api/twin/document.js](api/twin/document.js)**: threads `summary` + `replace`; returns the
  duplicate signal without an ack.
- **[public/twin.html](public/twin.html)**: store card shows the **real** count; when the doc already
  exists the card says "already in your twin" and the button becomes **Replace it**; a server-side
  duplicate is also handled as a safety net.
- **`chunkText`**: the **dead `overlap` param is now live** — a word-boundary tail carries across
  each boundary, and oversize single paragraphs are hard-split with overlap.
- **Acceptance ✅** — re-uploading the same file produces no duplicate; the CFTE handover is
  recognised as already present (verified via the Phase 3 dry-run hash grouping).

### Phase 2 — parent summary + whole-document retrieval
- **`addDocument`** creates a **parent summary record** (`chunk_index = 0`, `is_document_parent`
  metadata) embedded as its own vector — the whole-document notion that didn't exist before. The
  summary is the faithful propose-time summary, **dash-cleaned** (`stripDashes`). Skill docs skip it
  (their single whole record already serves the role).
- **[tools/retrieval.js](tools/retrieval.js)**: `search_twin` results now carry `document_id`,
  `chunk_index`, `is_document_parent`, and `expandable`. Parent vectors are **down-weighted**
  (`PARENT_SCORE_WEIGHT = 0.75`) so they represent the document without flooding unrelated searches.
- **`get_document(document_id)`** (new tool, registered on the main MCP server in
  [lib/create-server.js](lib/create-server.js)): returns the summary + every part in `chunk_index`
  order + the reassembled `full_text`.
- **Generalised** to all captures: `addFromUrl` and `addVoiceNote` now retain raw text on the
  `sources` row and link items via `source_id` + `chunk_index` (url also gets a parent summary).
  *(url/voice deliberately omit `content_hash` — a re-fetch/repeat is a refresh, not a duplicate, so
  they stay exempt from the idempotency index.)*
- **Acceptance ✅ (once 030 applied + reingested/backfilled)** — `get_document` reassembles parts in
  order and returns the stored full text; "summarise the whole X" can match the parent and expand.

### Phase 3 — backfill + dedupe (dry-run delivered; collapse gated)
- **[scripts/_doc-backfill.mjs](scripts/_doc-backfill.mjs)** (new): DRY-RUN by default. Groups
  existing chunks by `(tenant, source_ref)`, dedupes by exact content hash, reconstructs `full_text`,
  assigns `chunk_index`, plans parent vectors. `--apply-backfill` (non-destructive) and
  `--apply-collapse` (destructive; requires `--backup <file>` + `--yes`) are gated.
- **Dry-run report (run against prod today):**
  - 21 document groups; **1 duplicate-ingest cluster**.
  - **CFTE-Brain-Mastermind-Handover-Brief.docx: 3 ingests, 24 chunks → 1 document, 8 ordered parts,
    16 exact duplicates removed, 19,186 chars reconstructed** — exactly the brief's target.
  - Totals: knowledge 679 → 684 (−16 dup chunks, +21 parent summaries); sources 58 → 54
    (−4 redundant); 16 vectors to delete; 21 parent vectors to create.
  - Tenant scoping verified (two `CFTE_Brand_Spec.md` groups are different tenants, never merged).
- **Acceptance (pending the gated apply)** — collapse not run; awaiting your review of the dry-run.

---

## Verification done
- `node --check` on all 6 modified/new JS files — clean.
- **New unit tests** [tests/document-model.test.mjs](tests/document-model.test.mjs): hashing
  normalisation + idempotency semantics + chunk overlap + oversize split — **8/8 pass**.
- **Existing isolation suites against prod** (pre-030, proving the resilient fallbacks):
  `permissions.test.mjs` **9/9**, `creation-scoping.test.mjs` **5/5**.
- Phase 3 **dry-run executed** read-only against prod (report above).
- Not browser-verified: the upload flow needs auth + live Supabase/Pinecone/LLM + a real file, which
  a local preview can't exercise; the test suites + dry-run are the meaningful verification here.

---

## YOUR turn — apply sequence (I cannot do these from here)

This environment has no Supabase Management-API token and no `exec_sql` RPC, so I can't apply DDL or
run the destructive collapse. The code is written to **degrade gracefully** if deployed before 030
(resilient inserts), but the clean order is:

1. **Apply migration 030** — Supabase SQL editor, or
   `node scripts/run-migration.mjs schema/migrations/030-document-model.sql`
   with `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` exported.
2. **Deploy** — `npm run deploy:prod` (`vercel deploy --prod` + inngest resync). Phase 0 dedupe +
   Phase 1 idempotency + Phase 2 parent/get_document go live. New uploads are two-layer from here.
3. **Backfill existing data (optional but recommended), in order, reviewing between steps:**
   - `node --import ./scripts/reclassify/_preload-env.mjs scripts/_doc-backfill.mjs` (dry-run; re-read it)
   - `… scripts/_doc-backfill.mjs --apply-backfill` (non-destructive: fills columns, links sources,
     creates parent vectors — costs ~21 embedding calls)
   - `… scripts/_doc-backfill.mjs --apply-collapse --backup ./doc-backfill-backup.json --yes`
     (**destructive**: removes the 16 duplicate CFTE chunks + 4 redundant sources. Backup written first.)

## Phase 4 (deferred, optional)
Capture the original binary browser-side and store it in Supabase Storage, for re-extraction if the
extractor improves and original-file download. Not required for the model to work; not built.

## Notes / smaller decisions
- The parent summary is stored as a `knowledge` row of type `document` (so it flows through existing
  retrieval/rowMap machinery). It's down-weighted in ranking and excluded from type-filtered searches.
- `knowledge.content_hash` is intentionally **non-unique** (two docs may share a paragraph); only
  `sources.content_hash` is unique per tenant (the document idempotency key).
- `deleteDocument(ctx, sourceId)` is exported and tenant-scoped — used by the Phase 3 collapse
  script. (The replace path no longer uses it; see round 2 below.)

---

## Review round 2 (2026-06-07) — fixes + confirmations

### Fix 1 (done) — replace-path safety
`addDocument` replace no longer deletes first. It now **reuses the existing source row**, writes the
new chunks + parent, and **only then** deletes the previous chunks/vectors. A mid-write failure leaves
the prior document fully intact. Reusing the source row also sidesteps the `(tenant, content_hash)`
unique-index collision (the replacement has the same hash by construction). [tools/storage.js](tools/storage.js)

### Fix 2 (done) — backfill ordering across title formats, + a real bug it surfaced
- `partNumberOf` now matches **`part N` at the end regardless of separator** (`— part 1`, `– part 1`,
  `- part 1`, `, part 1`) — the dash cleaner shipped between ingests, so both forms exist. Ordering is
  **strictly by part number**, not created_at.
- Added an **order-verification** dump (`--verify <regex>`; CFTE by default) that prints the ordered
  parts with content heads and asserts a clean `1..N`. The CFTE handover verifies **`[1..8]`, reading
  Author/Status → Phase 1 → … → Background — correct order.**
- **This caught a real bug the count-based dry-run hid:** `cfte-proposal-reference.md` and
  `solution-designer-project-instructions.md` are **edited re-uploads** (same filename, *different*
  content per part → duplicate part numbers `[1,1,2,2,…]`). Merging them would interleave two versions
  and collapse the wrong source. Added a **coherence gate**: only documents whose parts form a clean
  distinct sequence are auto-reconstructed/collapsed; multi-version docs are routed to **MANUAL REVIEW**
  and get only the safe, order-independent per-chunk `content_hash`. New dry-run totals:
  **21 groups → 19 coherent, 2 manual-review; only the CFTE handover collapses (−16 chunks, −2 sources).**

### Confirmations (3–6)
3. **Deploy order is now a HARD sequence: apply 030 → deploy.** Idempotency depends on the partial
   unique index + the `content_hash` column. If new code runs before 030, `findExistingDocument` finds
   nothing and there's no index to catch a race → duplicates possible in that window. (Code still runs
   — resilient inserts — but the dedup guarantee is absent until 030 exists.)
4. **Library nesting: NOT built — still open.** We currently produce the 8 part rows **plus** a parent-
   summary row (type `document`, chunk_index 0). The brief's "one openable item with parts nested" UI in
   `library.html` was not implemented; right now the Library would show 9 rows for an 8-part doc. Needs a
   follow-up: group by `source_id`/`document_id`, render the parent as the openable item, nest the parts
   (and ideally hide bare part rows). **Flagged open.**
5. **get_document reachability: fixed for in-app + available via MCP.** It was registered on the MCP
   server (external clients can call it from its directive description) but the **in-app chat
   (`api/twin/turn.js`) is a non-agentic pre-fetch router that never invoked it** — "summarise the whole
   brief" got top-k. Added a guarded **whole-document expansion**: when the query asks for the
   whole/entire/full document and the top hit carries a `document_id`, the router calls `get_document`
   and injects the reassembled text (size-capped at 40k chars). Falls back to normal top-k on any miss.
   The system prompt is **not** modified (the env-hosted prompt isn't in repo); reachability is now code-
   enforced in-app rather than prompt-dependent.
6. Smaller:
   - **Parent summary runs through the dash cleaner** — yes (`stripDashes` in `storeParentSummary` and
     `docSummary`). ✓
   - **Retrieval dedupe keeps the highest-ranked survivor** — yes; `rankDedupeMatches` sorts by weighted
     score *before* the dedupe loop, and the post-fetch pass iterates in ranked order, so the first
     (highest) wins. ✓
   - **Parent-summary writes no longer fire the concept-compile job** — fixed: the
     `knowledge-inserted` webhook now skips rows with `chunk_index === 0`. ✓
   - **0.75 parent down-weight** — acknowledged as a guess; it's the `PARENT_SCORE_WEIGHT` constant in
     [tools/retrieval.js](tools/retrieval.js), to watch and tune once there's real whole-doc traffic.

### Still required before collapse (your manual prod acceptance pass)
Apply 030 → deploy → upload CFTE fresh → re-upload (expect the duplicate/replace prompt, not a 4th copy)
→ ask the twin to summarise the whole brief (expect in-order reassembly via the new whole-doc path) →
open it in the Library (note: parts not yet nested — item #4 above). Only then re-run the dry-run and run
the gated collapse with `--backup`.
