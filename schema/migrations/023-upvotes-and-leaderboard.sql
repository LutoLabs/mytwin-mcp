-- 023-upvotes-and-leaderboard.sql
-- The collaborative layer for the MyAITwin knowledge pool:
--   1. upvotes                 -- one vote per user per knowledge item (a toggle).
--   2. knowledge_with_counts   -- read-only view used only for the "Top"
--                                 library sort (DB-side ordering + pagination).
--                                 The base list still reads knowledge directly so
--                                 the library keeps working before this migration.
--   3. brain_leaderboard(tenant) -- per-contributor rollup: items authored and
--                                 upvotes received across those items.
--
-- Authorship is read from knowledge.user_id.
-- Safe to re-run: all objects use if-not-exists or or-replace.
-- Apply from the Supabase SQL editor for project eqacaypuutlqkncpjqbl.

begin;

-- ── Upvotes ──────────────────────────────────────────────────────────────────
create table if not exists upvotes (
  user_id      uuid        not null references users(id)     on delete cascade,
  knowledge_id uuid        not null references knowledge(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (user_id, knowledge_id)
);

create index if not exists upvotes_knowledge_idx on upvotes(knowledge_id);

-- ── knowledge_with_counts ────────────────────────────────────────────────────
-- Every knowledge column plus a denormalised upvote_count. Used solely by the
-- library list when sorting by "Top", so ranking + pagination happen in the DB.
create or replace view knowledge_with_counts as
  select k.*,
         coalesce(c.cnt, 0)::int as upvote_count
    from knowledge k
    left join (
      select knowledge_id, count(*)::int as cnt
        from upvotes
       group by knowledge_id
    ) c on c.knowledge_id = k.id;

-- ── brain_leaderboard(tenant) ────────────────────────────────────────────────
-- Per-contributor rollup for one tenant:
--   contributions    = distinct knowledge items the user authored in this tenant
--   upvotes_received = total upvotes across all those items
create or replace function brain_leaderboard(p_tenant_id uuid)
returns table (
  user_id          uuid,
  email            text,
  contributions    bigint,
  upvotes_received bigint
)
language sql
stable
as $$
  select k.user_id,
         u.email,
         count(distinct k.id)   as contributions,
         count(uv.knowledge_id) as upvotes_received
    from knowledge k
    join users u on u.id = k.user_id
    left join upvotes uv on uv.knowledge_id = k.id
   where k.tenant_id = p_tenant_id
   group by k.user_id, u.email;
$$;

commit;

notify pgrst, 'reload schema';
