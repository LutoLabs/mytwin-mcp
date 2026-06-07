-- 027-canon-provenance.sql
-- Eleusis canon seed — the twin's own self-knowledge and worldview.
--
-- Introduces a new SYSTEM-ASSIGNED provenance value 'canon'. Canon content is
-- the product's, not the user's, so it is attributed to Eleusis and walled off
-- from the machinery that learns the user's own thinking — exactly the way
-- client material already is.
--
-- Isolation model: canon rows are owned by a dedicated system tenant (and a
-- placeholder system user). Every existing query path is scoped by the
-- requester's (user_id, tenant_id), so canon is excluded BY CONSTRUCTION from
-- welcome/cold-start counts, the hypergraph, the library, find_patterns,
-- concept-page compilation, and edit/delete — without per-surface filters.
-- The one place we deliberately cross the tenant boundary is retrieval, which
-- merges a shared 'canon' Pinecone namespace for every tenant (see
-- tools/retrieval.js) and attributes the result to Eleusis (api/twin/turn.js).
--
-- 'canon' is never offered in the user-facing add_knowledge / update_knowledge
-- provenance enums, and tools/storage.js VALID_PROVENANCE excludes it, so a user
-- can never self-assign it. Canon rows are written only by scripts/load-canon.mjs
-- via a direct insert (which bypasses the tool layer).
--
-- The display label "Eleusis" is a runtime concern only — the stable internal
-- key 'canon' is what lands in the database, so renaming the product later is a
-- one-line label change in lib/canon.js, not a data migration.
--
-- Safe to re-run.

begin;

-- ── 1. Widen the provenance CHECK constraint to include 'canon' ───────────────
-- Drop-then-add keeps this idempotent, matching migration 016.
alter table knowledge
  drop constraint if exists knowledge_provenance_check;

alter table knowledge
  add constraint knowledge_provenance_check
  check (provenance in ('personal', 'organisational', 'employer', 'client', 'external', 'canon'));

-- ── 2. System tenant + user that own every canon row ──────────────────────────
-- Fixed UUIDs, mirrored in lib/canon.js, so retrieval and the loader reference
-- them as constants. tenants.is_anonymous defaults to false. The placeholder
-- email follows the anon-tenant convention (anon+<id>@mytwin.local) and keeps
-- the users.email NOT NULL UNIQUE contract intact.
insert into tenants (id)
  values ('e1e051c0-0000-4000-8000-000000000001')
  on conflict (id) do nothing;

insert into users (id, email, tenant_id)
  values ('e1e051c0-0000-4000-8000-000000000002', 'canon@system.local', 'e1e051c0-0000-4000-8000-000000000001')
  on conflict (id) do nothing;

commit;
