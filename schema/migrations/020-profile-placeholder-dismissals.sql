-- 020-profile-placeholder-dismissals.sql
-- Profile v1 (Sub-phase 4): the empty-state placeholder system.
--
-- When an owner's personal workspace has fewer than a small threshold of items,
-- the Profile hypergraph renders seven "ghost" placeholder nodes that nudge the
-- owner to seed their twin (writing voice, brand spec, operating principles, …).
-- A placeholder slot disappears once the owner either FILLS it (which creates a
-- real knowledge item) or DISMISSES it (the X on hover). This table records both
-- outcomes so the dismissed/filled slot never reappears.
--
-- One row per (workspace, placeholder). `source` distinguishes the two outcomes
-- for debuggability; neither feature branches on it — both simply hide the slot.
-- A fill ALSO inserts a knowledge item via the normal ingestion path; this table
-- only tracks slot state, never knowledge content.
--
-- ADDITIVE ONLY: brand-new table, no change to existing tables, no data touched.
-- Safe to re-run (create-if-not-exists + on-conflict-do-nothing writes).

begin;

create table if not exists profile_placeholder_dismissals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid        not null references users(id)      on delete cascade,
  workspace_id   uuid        not null references workspaces(id) on delete cascade,
  placeholder_id text        not null,
  source         text        not null default 'dismissed',  -- 'dismissed' | 'filled'
  dismissed_at   timestamptz not null default now(),
  unique (workspace_id, placeholder_id)
);

create index if not exists idx_placeholder_dismissals_workspace
  on profile_placeholder_dismissals(workspace_id);

alter table profile_placeholder_dismissals enable row level security;

commit;

-- Reload PostgREST's schema cache so the new table is visible immediately when
-- applied by hand via the Supabase SQL editor.
notify pgrst, 'reload schema';
