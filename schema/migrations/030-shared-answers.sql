-- 030-shared-answers.sql
-- Public sharing (Phase 1): make a twin chat answer a shareable public artifact.
--
-- Chat answers are not otherwise persisted as addressable resources. When a user
-- chooses to share an answer publicly, we snapshot exactly the text they are
-- looking at into shared_answers (a deliberate, explicit act — the user sees the
-- content before confirming) and point a public_links row at it. This keeps the
-- knowledge base and the compiled concept pages clean: a shared answer is its own
-- artifact, never mixed into retrieval or the Wiki.
--
-- We also widen public_links to reference EXACTLY ONE of three object types
-- (item XOR concept XOR answer), replacing the two-way XOR from migration 029
-- with num_nonnulls(...) = 1.
--
-- ADDITIVE + a constraint swap on a table with zero rows in prod (public sharing
-- has not shipped yet), so no data is touched. Safe to re-run. RLS enabled, no
-- policies, like every other table.

begin;

create table if not exists shared_answers (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id)   on delete cascade,
  tenant_id   uuid        not null references tenants(id) on delete cascade,
  title       text,
  content     text        not null,
  citations   jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists shared_answers_owner_idx on shared_answers(user_id, created_at desc);

alter table shared_answers enable row level security;

-- Widen public_links to a third object type.
alter table public_links add column if not exists object_answer_id uuid references shared_answers(id) on delete cascade;

-- Replace the two-way XOR with an exactly-one-of-three check.
alter table public_links drop constraint if exists public_links_one_object;
alter table public_links add constraint public_links_one_object
  check (num_nonnulls(object_item_id, object_concept_page_id, object_answer_id) = 1);

-- Lookup + one-active-link-per-answer, mirroring the item/concept indexes.
create index if not exists public_links_answer_idx
  on public_links(object_answer_id) where object_answer_id is not null;
create unique index if not exists public_links_active_answer_uniq
  on public_links(object_answer_id) where (not revoked and object_answer_id is not null);

commit;

-- Reload PostgREST's schema cache so the new table/column are visible at once.
notify pgrst, 'reload schema';
