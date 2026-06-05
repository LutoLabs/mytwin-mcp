-- 025-reconciliation-foundations.sql
-- Phase 1 of the reconciliation system: DATA-MODEL FOUNDATIONS ONLY.
--
-- Reconciliation decides the relationship between an incoming fragment and what
-- is already stored, so the twin compounds instead of accumulating near-dupes.
-- This migration adds ONLY the primitives the audit found absent. It is purely
-- additive and changes no existing behaviour: every new column is defaulted so
-- existing rows and ingestion paths are unaffected, and nothing here is wired
-- into the write path yet (that is Phase 2 shadow-mode).
--
-- Post-insert model (signed off): the "fragment" is the freshly-stored item, so
-- there is NO separate staging table — decisions reference incoming_item_id. The
-- existing knowledge_versions table already covers ItemVersion, so it is reused.
--
-- Safe to re-run (if-not-exists throughout). No destructive change. Reversible:
-- the three new tables and three new columns can be dropped without data loss.
-- Apply from the Supabase SQL editor for project eqacaypuutlqkncpjqbl.

begin;

-- ── knowledge: lifecycle + lineage (additive, defaulted) ──────────────────────
-- status defaults 'active' so every existing row keeps its current behaviour.
-- superseded_by / merged_into are the lineage pointers (never hard-delete; the
-- old item and all its versions persist — this is what makes undo trivial).
alter table knowledge
  add column if not exists status        text default 'active',
  add column if not exists superseded_by uuid references knowledge(id) on delete set null,
  add column if not exists merged_into    uuid references knowledge(id) on delete set null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'knowledge_status_chk') then
    alter table knowledge
      add constraint knowledge_status_chk check (status in ('active','superseded','merged'));
  end if;
end $$;

create index if not exists knowledge_status_idx on knowledge(tenant_id, user_id, status);

-- ── item_links: typed item↔item relationships (ElaborationS keep both apart) ──
create table if not exists item_links (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants(id)   on delete cascade,
  from_item_id uuid        not null references knowledge(id) on delete cascade,
  to_item_id   uuid        not null references knowledge(id) on delete cascade,
  kind         text        not null check (kind in ('elaborates','parent_of','related','supersedes','merged_into')),
  created_by   text        not null default 'ai' check (created_by in ('ai','user')),
  created_at   timestamptz not null default now(),
  unique (from_item_id, to_item_id, kind)
);
create index if not exists item_links_from_idx on item_links(from_item_id);
create index if not exists item_links_to_idx   on item_links(to_item_id);

-- ── reconciliation_decisions: audit log of EVERY decision (reversible) ────────
-- One row per (incoming item, candidate) judgement. `shadow=true` rows are
-- logged-only with no write taken (Phase 2). `reverse_token` describes how to
-- undo an auto-action. This table also feeds telemetry (§15).
create table if not exists reconciliation_decisions (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants(id) on delete cascade,
  user_id           uuid        not null references users(id)   on delete cascade,
  incoming_item_id  uuid        references knowledge(id) on delete set null,  -- the freshly-stored item being reconciled
  candidate_item_id uuid        references knowledge(id) on delete set null,  -- what it was compared against (null = DISTINCT/created)
  relationship      text        not null check (relationship in
                      ('DUPLICATE','REFINEMENT','SUPERSEDE','CONTRADICTION','ELABORATION','DISTINCT','NONE')),
  confidence        real,
  direction         text        check (direction in ('fragment_more_general','item_more_general','n/a') or direction is null),
  rationale         text,
  action            text        not null check (action in ('create','attach','version','supersede','link','escalate','none')),
  auto              boolean     not null default true,   -- auto vs user-driven
  actor             text        not null default 'ai' check (actor in ('ai','user')),
  reverse_token     jsonb,                               -- opaque undo descriptor
  shadow            boolean     not null default false,  -- logged-only, no write performed
  created_at        timestamptz not null default now()
);
create index if not exists recon_decisions_item_idx   on reconciliation_decisions(incoming_item_id);
create index if not exists recon_decisions_tenant_idx on reconciliation_decisions(tenant_id, created_at desc);

-- ── review_items: escalation queue → batched confirm UI ───────────────────────
-- A pending decision handed to the user (low confidence, or a CONTRADICTION).
-- `proposals` holds the ranked candidate relationships+actions the UI renders.
create table if not exists review_items (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants(id) on delete cascade,
  user_id          uuid        not null references users(id)   on delete cascade,
  incoming_item_id uuid        references knowledge(id) on delete cascade,
  proposals        jsonb       not null default '[]'::jsonb,
  state            text        not null default 'pending' check (state in ('pending','resolved','expired')),
  resolution       jsonb,
  resolved_by      uuid        references users(id),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists review_items_pending_idx on review_items(tenant_id, user_id) where state = 'pending';

commit;

notify pgrst, 'reload schema';
