-- 029-public-links.sql
-- Public sharing (Phase 0/1): link-to-anyone, read-only public artifact links.
--
-- This is the link-to-anyone mechanism, deliberately SEPARATE from two existing
-- systems it must never blur into:
--   * the per-item email grants (permissions / invitations tables) which are
--     person-to-person and carry a 5-level permission model;
--   * the visibility column ('private' | 'sharable') which governs the owner's
--     whole-twin shared MCP token pool.
-- A public_links row is its own explicit, revocable grant: its presence (not
-- revoked, not expired) is the sole authorization for a logged-out read of ONE
-- artifact. Default state for every artifact remains private (no row).
--
-- Each link points at EXACTLY ONE artifact: a knowledge item XOR a concept page
-- (the same XOR shape the permissions table uses for subject/object). The slug
-- is an unguessable 144-bit random token; the URL carries it raw so the owner
-- can re-copy and revoke it later (these are public artifacts by definition, so
-- storing the raw slug is acceptable, unlike a private bearer credential).
--
-- ADDITIVE ONLY: brand-new table, no change to existing tables, no data touched,
-- no dependency on migration 028 (openness). Safe to re-run (create-if-not-
-- exists). RLS is enabled with no policies, like every other table — the app
-- uses the service-role key (which bypasses RLS); enabling it blocks the anon/
-- auth keys as defense in depth. Tenant isolation is enforced in application
-- code (lib/data-access.js, lib/public-links.js).

begin;

create table if not exists public_links (
  id                     uuid        primary key default gen_random_uuid(),
  slug                   text        not null unique,
  object_item_id         uuid        references knowledge(id)      on delete cascade,
  object_concept_page_id uuid        references concept_pages(id)  on delete cascade,
  owner_user_id          uuid        not null references users(id)   on delete cascade,
  tenant_id              uuid        not null references tenants(id) on delete cascade,
  revoked                boolean     not null default false,
  view_count             integer     not null default 0,
  expires_at             timestamptz,
  created_at             timestamptz not null default now(),
  last_viewed_at         timestamptz,
  -- Exactly one object: an item XOR a concept page (never both, never neither).
  constraint public_links_one_object
    check ((object_item_id is null) <> (object_concept_page_id is null))
);

-- Slug lookup is the hot path for every public read; the unique constraint above
-- already indexes it. These speed owner-side "do I have a link for this artifact"
-- lookups and revocation.
create index if not exists public_links_item_idx    on public_links(object_item_id)         where object_item_id is not null;
create index if not exists public_links_concept_idx on public_links(object_concept_page_id) where object_concept_page_id is not null;
create index if not exists public_links_owner_idx   on public_links(owner_user_id, created_at desc);

-- At most ONE active (non-revoked) link per artifact, so "create a public link"
-- is get-or-create and "revoke" is unambiguous. This is the partial unique index
-- the shared_mcp_tokens comment once promised but never created.
create unique index if not exists public_links_active_item_uniq
  on public_links(object_item_id)         where (not revoked and object_item_id         is not null);
create unique index if not exists public_links_active_concept_uniq
  on public_links(object_concept_page_id) where (not revoked and object_concept_page_id is not null);

alter table public_links enable row level security;

commit;

-- Reload PostgREST's schema cache so the new table is visible immediately when
-- applied by hand via the Supabase SQL editor.
notify pgrst, 'reload schema';
