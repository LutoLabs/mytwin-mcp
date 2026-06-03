-- Migration 024 — synthesis-page staleness
-- Concept pages are the synthesis-page layer: agent-compiled distillations of
-- knowledge clusters. When a related knowledge item is added we mark the
-- matching pages stale (cheap, synchronous) and recompile them later via a
-- debounced background job — never recompiling all pages on every ingest.
--
--   is_stale    — true once a related item has been added since the last compile.
--   stale_since — when the page was marked stale (for the "updating" UI badge).
--
-- Safe to re-run: add-column-if-not-exists + index-if-not-exists.
-- Apply from the Supabase SQL editor for project eqacaypuutlqkncpjqbl.

alter table concept_pages
  add column if not exists is_stale    boolean      not null default false,
  add column if not exists stale_since timestamptz;

-- Partial index: fast lookup of just the stale pages for a tenant/user.
create index if not exists concept_pages_stale_idx
  on concept_pages (tenant_id, user_id)
  where is_stale = true;

notify pgrst, 'reload schema';
