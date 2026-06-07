-- 030-document-model.sql
-- Two-layer document model: the `sources` row becomes the durable DOCUMENT
-- PARENT (raw full text as the source of truth + a content hash for idempotency),
-- and `knowledge` chunks gain a real foreign key to their source plus an explicit
-- chunk_index. This replaces the prior string-only link (source_ref == filename).
--
-- ADDITIVE and reversible. source_ref is kept for backward compatibility; source_id
-- is the new durable link. Nothing is dropped. Deliberately SEPARATE from the
-- living-document fields (version_number, is_living_document, superseded_by,
-- merged_into) — those model how a derived record evolves, not document parentage.
--
-- Mirrors the proven `notes` pattern: raw retained, never embedded; derived records
-- link back. Storing the original binary (Supabase Storage) is a later optional
-- phase and is NOT part of this migration.
--
-- Safe to re-run (add column / index if not exists).

begin;

-- ── sources becomes the document parent ──────────────────────────────────────
--   full_text     the raw extracted text the server received (source of truth).
--                 Immutable once written by application convention.
--   content_hash  sha256 of normalised(full_text) + tenant, the idempotency key.
alter table sources
  add column if not exists full_text    text,
  add column if not exists content_hash text;

-- Idempotency: at most one document per (tenant, content_hash). Partial so legacy
-- rows with a null hash never collide. A re-upload of the same text resolves here.
create unique index if not exists sources_tenant_content_hash_uniq
  on sources (tenant_id, content_hash)
  where content_hash is not null;

-- ── knowledge chunks link durably to their source ────────────────────────────
--   source_id     FK to the parent document (sources.id). on delete set null so
--                 deleting a source never cascades away a member's data silently;
--                 the replace/collapse flows delete chunks explicitly.
--   chunk_index   0 = parent summary record, 1..N = ordered parts.
--   content_hash  sha256 of normalised(chunk content), for retrieval-time dedupe.
alter table knowledge
  add column if not exists source_id    uuid references sources(id) on delete set null,
  add column if not exists chunk_index  integer,
  add column if not exists content_hash text;

create index if not exists knowledge_source_id_idx     on knowledge (source_id);
create index if not exists knowledge_content_hash_idx  on knowledge (tenant_id, content_hash);

commit;

-- Reload PostgREST's schema cache so supabase-js sees the new columns immediately
-- (matters when applied by hand via the SQL editor).
notify pgrst, 'reload schema';
