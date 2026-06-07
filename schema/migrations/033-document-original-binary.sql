-- 033-document-original-binary.sql
-- Phase 4 of the two-layer document model: keep the ORIGINAL uploaded binary
-- (PDF / DOCX) alongside the extracted text, so the document can be re-extracted
-- if the extractor improves and downloaded in its original form.
--
-- The binary itself lives in Supabase Storage (a private bucket, default name
-- "documents"), NOT in Postgres. These columns on the `sources` parent record
-- only POINT at it:
--   original_key    the Storage object path (tenant_id/source_id/<filename>)
--   original_mime   content type, so downloads serve correctly
--   original_bytes  size, for display / sanity
--
-- ADDITIVE and reversible. Entirely optional: a document with no original_key
-- still works exactly as before (text-only). Only pdf/docx uploads populate it;
-- txt/md never do (their extracted text IS the original).
--
-- PREREQUISITE (one-time, by hand): create a PRIVATE Storage bucket named
-- "documents" (Supabase Dashboard → Storage → New bucket, Public = off). No RLS
-- policies are needed: the app accesses it via the service-role key and hands
-- out short-lived signed URLs. See DOC_INGESTION_BUILD.md.
--
-- Safe to re-run (add column if not exists).

begin;

alter table sources
  add column if not exists original_key    text,
  add column if not exists original_mime   text,
  add column if not exists original_bytes  integer;

commit;

notify pgrst, 'reload schema';
