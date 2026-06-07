-- 028-teamspace-openness.sql
-- Teamspace openness (Phase 3+, MyAITwin Home v3).
--
-- A "teamspace" is a permission_group within an org workspace. Until now every
-- teamspace was effectively "closed": visible to workspace members, but its
-- content is shown only to those added to the group. This adds the Notion-style
-- openness dimension:
--   open     any workspace member may enter (no per-group invite needed)
--   closed   visible to members, but entry is invite-only (the prior behaviour)
--   private  invisible to non-members; only members (and owner/admin) see it exists
--
-- ADDITIVE ONLY. Default 'closed' preserves today's behaviour exactly. There are
-- currently zero permission_groups, so this backfills no rows. Fully reversible:
--   alter table permission_groups drop column openness;
--
-- Safe to re-run (add column if not exists).

begin;

alter table permission_groups
  add column if not exists openness text not null default 'closed'
  check (openness in ('open', 'closed', 'private'));

commit;

-- Reload PostgREST's schema cache so supabase-js / the REST API see the new
-- column immediately (matters when applied by hand via the SQL editor).
notify pgrst, 'reload schema';
