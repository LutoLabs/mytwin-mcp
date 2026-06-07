-- 026-notes.sql
-- Voice rebuild (Phase 1): the standalone Notes store.
--
-- Capturing a note and committing it to the twin are now two different acts.
-- A Note is a plain transcription record: private, readable, editable,
-- downloadable, shareable — and NOT retrievable by the twin. It never gets an
-- embedding, so it can never surface in search, synthesis, pattern-finding, or
-- concept compilation. The twin only ever sees what a person deliberately
-- promotes (the "Add to Twin" flow stores a separate knowledge row via
-- confirm-store with source_type = 'voice-capture').
--
-- promoted_knowledge_id is the two-state marker: null = a plain note; set = the
-- note has been promoted, and we link to the resulting knowledge item. ON DELETE
-- SET NULL so deleting the twin item leaves the note intact (it just reverts to
-- looking un-promoted).
--
-- ADDITIVE ONLY: brand-new table, no change to existing tables, no data touched.
-- Safe to re-run (create-if-not-exists). RLS is enabled with no policies, exactly
-- like the other tables — all server access goes through the service-role key,
-- which bypasses RLS; enabling it blocks the anon/auth keys as defense in depth.

begin;

create table if not exists notes (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references users(id)     on delete cascade,
  tenant_id             uuid        not null references tenants(id)   on delete cascade,
  title                 text,
  transcript            text        not null,
  mode                  text        not null default 'quick' check (mode in ('quick', 'meeting')),
  duration_ms           integer,
  promoted_knowledge_id uuid        references knowledge(id) on delete set null,
  promoted_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists notes_user_created_idx   on notes(user_id,   created_at desc);
create index if not exists notes_tenant_created_idx on notes(tenant_id, created_at desc);

alter table notes enable row level security;

commit;

-- Reload PostgREST's schema cache so the new table is visible immediately when
-- applied by hand via the Supabase SQL editor.
notify pgrst, 'reload schema';
