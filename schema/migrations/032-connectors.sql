-- 032-connectors.sql
-- Outbound read-connector foundation (shared by Fireflies / Fathom / Granola /
-- Zoom and, later, Notion / Drive / Gmail).
--
-- This is the OUTBOUND half the recon flagged as missing: the existing
-- api/oauth/* layer makes the twin an authorization SERVER (clients connect IN);
-- connectors need the twin to be a CLIENT that connects OUT and pulls data in.
-- None of that existed. Two additive, reversible tables:
--
--   connections        — one row per (tenant, provider, account). Holds the
--                        REVERSIBLY-ENCRYPTED credential (API key / OAuth access
--                        + refresh token — encrypted app-side via
--                        lib/connector-crypto.js, never plaintext at rest), the
--                        sync cursor, and status. Unlike the inbound oauth_*
--                        tables which store sha256 HASHES (verify-only), these
--                        must be decryptable because the twin replays them to the
--                        provider on every pull.
--
--   connection_sources — the (provider, external_id) -> source_id map. This is
--                        what makes a re-pulled or EDITED transcript update its
--                        existing document instead of duplicating. Content-hash
--                        (sources.content_hash, migration 030) is the secondary
--                        backstop; this native-id map is the primary key for sync.
--
-- Numbering note: 030 and 031 each already collide in this tree
-- (030-document-model / 030-shared-answers; 031-document-original-binary /
-- 031-referral-attribution). This file is the first unambiguous 032.
--
-- Reversible: `drop table if exists connection_sources, connections cascade;`

-- ── connections ───────────────────────────────────────────────────────────────
create table if not exists connections (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants(id) on delete cascade,
  user_id             uuid        not null references users(id)   on delete cascade,

  provider            text        not null,            -- 'fireflies' | 'fathom' | 'granola' | 'zoom'
  auth_type           text        not null,            -- 'api_key' | 'oauth'

  -- Provider-side identity, captured at connect for display + webhook routing.
  external_account_id text,                             -- provider user/account id (e.g. Fireflies user_id)
  display_name        text,                             -- e.g. the account email, shown in the UI

  -- Reversibly-encrypted credentials. Ciphertext only; the key lives in the
  -- CONNECTOR_ENCRYPTION_KEY env var, never in the DB. See lib/connector-crypto.js.
  secret_ciphertext   text,                             -- API key (api_key) or access token (oauth)
  refresh_ciphertext  text,                             -- refresh token (oauth only)
  token_expires_at    timestamptz,                      -- oauth access-token expiry (drives refresh)
  scopes              text,                             -- granted scopes (oauth)

  -- Per-connection webhook signing secret (encrypted). The provider's webhook is
  -- routed back to THIS connection via ?c=<id> and verified with this secret.
  webhook_secret_ciphertext text,

  -- Sync state.
  status              text        not null default 'active',   -- 'active' | 'error' | 'revoked'
  last_error          text,
  cursor              jsonb       not null default '{}'::jsonb, -- { skip, last_external_date, page_token, backfill_done }
  last_synced_at      timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One active connection per (tenant, provider, account). COALESCE keeps a
-- not-yet-identified account ('' ) unique so a double-connect updates in place.
create unique index if not exists connections_tenant_provider_account_uniq
  on connections (tenant_id, provider, coalesce(external_account_id, ''));
create index if not exists connections_tenant_idx   on connections (tenant_id);
create index if not exists connections_provider_idx on connections (provider);

-- ── connection_sources ────────────────────────────────────────────────────────
-- The native-id map. (tenant, provider, external_id) is the idempotency key for
-- sync: a re-delivered webhook or an edited transcript resolves to the same row,
-- so we UPDATE the linked source instead of creating a duplicate document.
create table if not exists connection_sources (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants(id)     on delete cascade,
  connection_id       uuid        not null references connections(id) on delete cascade,

  provider            text        not null,
  external_id         text        not null,            -- e.g. Fireflies transcript/meeting id

  -- The ingested document. ON DELETE CASCADE: if the user deletes the document,
  -- the map row goes too, so a later sync cleanly re-creates it (mirror semantics).
  source_id           uuid        references sources(id) on delete cascade,

  content_hash        text,                             -- last ingested hash (secondary dedupe backstop)
  external_updated_at timestamptz,                      -- provider's last-edited time, if exposed
  ingested_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists connection_sources_provider_extid_uniq
  on connection_sources (tenant_id, provider, external_id);
create index if not exists connection_sources_connection_idx on connection_sources (connection_id);
create index if not exists connection_sources_source_idx     on connection_sources (source_id);

-- Defence-in-depth RLS (the app uses the service-role key and enforces tenant
-- scoping in lib/connections.js; this mirrors the rest of the schema).
alter table connections        enable row level security;
alter table connection_sources enable row level security;
