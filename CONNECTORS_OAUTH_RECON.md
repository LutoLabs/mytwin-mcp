# Connectors / OAuth Recon — read-only findings

**Date:** 2026-06-07 · **Scope:** what exists today before building one-way read connectors (Notion, Google Drive, Gmail). Read-only audit — nothing changed.

## TL;DR (the one thing that matters)

The OAuth framework that exists runs the **wrong direction** for connectors. It makes the twin an **OAuth 2.0 _authorization server_** — it lets external MCP clients (Claude Desktop / Claude Code) connect **into** the twin and get a bearer token for the twin's MCP endpoint. Connectors need the twin to be an **OAuth _client_** that connects **out** to Notion / Google and pulls data **in**. None of that outbound half exists — not even a stub.

What you **can** build on, and it's substantial, is the **ingestion foundation**: `addDocument`, the two-layer `sources` + `knowledge` document model, content-hash idempotency, Pinecone embedding, and Inngest background processing. Connectors should normalise each remote item to text and feed that pipeline.

So: keep the ingestion target, **build a brand-new outbound connection layer.** Do not try to extend `api/oauth/*` — it's the mirror image of what you need.

---

## 1. The framework

**Yes, there's a generic OAuth/auth layer — but it is inbound (twin = authorization server).**

| Piece | Location |
|---|---|
| OAuth helpers (codes, PKCE, refresh, redirect matching) | [lib/oauth.js](lib/oauth.js) |
| Authorize / callback / token / dynamic-client-registration endpoints | [api/oauth/authorize.js](api/oauth/authorize.js), [api/oauth/callback.js](api/oauth/callback.js), [api/oauth/token.js](api/oauth/token.js), [api/oauth/register.js](api/oauth/register.js) |
| User auth (magic-link sign-in, session) | [api/auth/](api/auth/), [lib/auth.js](lib/auth.js) |
| Tables | `oauth_clients`, `oauth_auth_codes`, `oauth_refresh_tokens`, `mcp_tokens` |
| Migrations | [002-mcp-tokens.sql](schema/migrations/002-mcp-tokens.sql), [007-oauth.sql](schema/migrations/007-oauth.sql), [008-oauth-pkce-refresh.sql](schema/migrations/008-oauth-pkce-refresh.sql) |

What it handles (all **inbound**, i.e. the twin issuing credentials to clients calling _it_):

- **Redirect + token-exchange flow** — full RFC 6749 auth-code flow, but the redirect is the twin's own magic-link round-trip; the "callback" is `claude.ai`/loopback receiving a code the **twin** minted.
- **PKCE (S256)** — required; verified constant-time (`verifyPkce`).
- **Refresh tokens** — rotating, single-use, hashed at rest, 30-day TTL, replay-safe (`issueRefreshToken` / `consumeRefreshToken`).
- **Token storage** — sha256 hashes only; raw shown once (see §3).
- **A "connections" record** — the closest analog is `oauth_clients` (apps allowed to call the twin) + `mcp_tokens` (per-user/per-client access tokens). **This is the inverse of a connector `connections` table** — it records who may read the twin, not which third parties the twin may read.
- **Per-provider config** — none. There is no notion of an external provider to configure. The only client config is one hard-seeded row: `claude-desktop` (see §2).

There is **no** generic outbound OAuth client, no third-party token store, no provider registry, no `connections`/`integrations` table. Confirmed by full-tree grep: no `googleapis`/Notion/Gmail SDK in `package.json`, no provider code, no connection/integration migration.

## 2. Providers wired

| Provider | State | Scopes |
|---|---|---|
| **Claude Desktop / Claude Code** (inbound MCP client) | **Live** — seeded `oauth_clients` row `claude-desktop`, public client (`token_endpoint_auth_method = none` + PKCE), loopback-port-agnostic redirect matching | MCP endpoint access (the twin's own surface). Not third-party scopes. |
| **Notion** | **Nonexistent** — not stubbed | — |
| **Google Drive** | **Nonexistent** — not stubbed | — |
| **Gmail** | **Nonexistent** — not stubbed | — |
| Any other third party | **Nonexistent** | — |

Only one OAuth client row exists, and it points the wrong way. There is no scaffold to extend for Notion/Drive/Gmail.

## 3. Token storage & security

**For the inbound tokens that exist:** strong, but built on **one-way hashing** — which is exactly what outbound connectors _cannot_ use.

- **Hashed, not encrypted.** `mcp_tokens.token_hash` and `oauth_refresh_tokens.token_hash` store `sha256(raw)`. Raw value returned to the client once, never persisted. Correct for inbound (you only ever _verify_ a presented token).
- **Tenant-scoped.** Every token row carries `tenant_id` + `user_id`. App-layer isolation is enforced through [lib/data-access.js](lib/data-access.js) (service-role key bypasses Postgres RLS; RLS is enabled as defence-in-depth only).
- **Refresh / revocation.** Rotating single-use refresh tokens (`revoked_at`, `rotated_to`), atomic compare-and-set consumption, 24 h access-token expiry / 30 d refresh.

**The gap for connectors:** outbound access/refresh tokens must be stored **reversibly** — the twin has to replay them to Notion/Google on every pull. A hash is useless there. **No reversible-encryption helper exists anywhere** in the repo — grep for `createCipheriv` / `aes-256` / `KMS` / `ENCRYPTION_KEY` returns nothing; the codebase only knows sha256. So connectors need a new encrypted-at-rest token store (envelope encryption / KMS / a libsodium secretbox) plus a tenant-scoped `connections` table. None of that is present.

## 4. Import path

**The ingestion foundation is real and is the right target.** Route connectors through it.

- Entry point: `addDocument(ctx, { filename, content, type, summary, replace })` in [tools/storage.js:421](tools/storage.js) (exposed as the `add_document` MCP tool via [lib/create-server.js](lib/create-server.js)).
- **Two-layer model** ([030-document-model.sql](schema/migrations/030-document-model.sql)): a `sources` parent row holds raw `full_text` (source of truth, immutable) + `content_hash`; `knowledge` rows are the chunks (FK `source_id`, `chunk_index` 1..N) plus a parent-summary vector at `chunk_index 0`. Chunks are embedded to Pinecone.
- A working precedent for "fetch remote → ingest" already exists: `addFromUrl(ctx, {url})` ([tools/storage.js:336](tools/storage.js)) fetches a URL (SSRF-guarded: DNS-resolved, private-IP-blocked, size-capped), strips HTML, and ingests through the same path. A connector's per-item handler is structurally this minus the fetch-by-URL and plus provider auth.

**Recommendation:** each connector normalises a remote item (Notion page, Drive file, Gmail message) to text + a filename/title, then calls `addDocument`. It inherits chunking, embedding, parent-summary, and idempotency for free.

> ⚠️ Migration **030 is written but NOT yet applied to prod** (per project memory). The two-layer model the connectors depend on is not live until 030 is applied + deployed.

## 5. Sync model

**One-shot push only. No pull, no schedule, no incremental state.**

- Inngest **is** wired ([lib/inngest.js](lib/inngest.js), [api/inngest.js](api/inngest.js)). But the five registered jobs are all **post-ingestion processing** — `compileConceptsJob`, `recompileStaleJob`, `reconcileItemJob`, `detectSkillJob`, `nightlyLintJob` ([lib/background-jobs.js](lib/background-jobs.js)) — triggered by a knowledge-inserted webhook ([api/webhooks/knowledge-inserted.js](api/webhooks/knowledge-inserted.js)).
- The only scheduled job is one Vercel cron, `/api/cron/inngest-sync` (daily 06:00, [vercel.json](vercel.json)) — it merely re-registers Inngest functions; it pulls **no data**.
- There is **no** connector-sync job, **no** `last_synced_at` / cursor / delta state anywhere.

**What connectors need built:** a per-connection sync cursor (`last_synced_at`, provider page-token / `historyId` / `last_edited_time`), and a sync driver — either an Inngest scheduled function fanning out per connection, or on-demand "sync now." All new.

## 6. Idempotency

**Yes — by content hash — but that is not enough for connectors.**

- Document grain: `hashDocument(text, tenant)` = `sha256(normalised_text + tenant)` → unique index `sources_tenant_content_hash_uniq`. A re-pull of byte-identical content returns a `duplicate: true` signal instead of storing twice ([tools/storage.js:434](tools/storage.js)). Race-safe (handles the 23505 unique-violation path).
- Chunk grain: `hashChunk(text)` for retrieval-time dedupe ([lib/content-hash.js](lib/content-hash.js)).

**The gap:** dedupe is **content-only**. There is no mapping from a provider's native ID (Notion `page_id`, Drive `file_id`, Gmail `message_id`) to a `source_id`. Consequences for a naive connector:

- An **edited** remote doc hashes differently → ingests as a **new** document, not an update of the existing one (silent duplication of the "same" item).
- **Renames / deletes / moves** on the provider side can't be reflected — nothing links a `sources` row back to its origin.

Connectors need a new external-id ↔ `source_id` mapping (per connection) layered on top of the content hash to do real upsert/delete sync.

## 7. UI

**There is a connect-and-manage surface, but it manages _inbound_ MCP tokens, not outbound connections.**

- `public/account.html` — "Generate shared MCP link" / show active token prefix + dates / Revoke. Backed by [api/dashboard/regenerate-token.js](api/dashboard/regenerate-token.js) and [api/account/index.js](api/account/index.js). This manages `mcp_tokens` (who can read the twin).
- The OAuth consent page ([api/oauth/authorize.js](api/oauth/authorize.js)) is branded but is the **inbound** authorization screen.
- Per project memory, `account.html` was merged into `profile.html` and the app front door moved to `/twin` — so the live management surface is the profile page.
- There is **no** "Connections" / "Integrations" page for outbound providers, and nothing in the current shell links to one.

---

## Per-provider: what works vs. what's needed

**Shared starting point (true for all three):** ingestion target (`addDocument` + two-layer model), content-hash idempotency, Pinecone embedding, Inngest processing, and the SSRF-guarded fetch pattern from `addFromUrl`. The inbound OAuth code (PKCE, rotation, hash-at-rest) is **reusable as expertise, not as a code path** — the direction is opposite.

**Shared gaps (true for all three):** outbound OAuth client (authorize → callback → code exchange → store access+refresh); a tenant-scoped `connections` table; **reversible encrypted** token storage (none exists today); per-item → text normalisation; external-id ↔ `source_id` mapping; and a sync cursor + driver. Plus: apply migration 030.

### Notion
- **Works today:** nothing Notion-specific. Ingestion + idempotency foundation only.
- **Needs:** public Notion OAuth integration (auth-code flow; Notion tokens are long-lived bearer — **no PKCE, no refresh rotation**, so the rotation machinery here doesn't transfer); read capabilities/scopes on the integration; `search` + paginated `blocks.children` to assemble page text → markdown; `page_id` as external id; `last_edited_time` for incremental. Simplest of the three (single OAuth client, no Google verification gauntlet).

### Google Drive
- **Works today:** nothing Drive-specific.
- **Needs:** a Google Cloud project + OAuth consent screen; Google OAuth (auth-code **+ PKCE + offline refresh tokens** — this part maps conceptually to the existing inbound PKCE/refresh logic, but as a new outbound client); scope `drive.readonly` (or narrower `drive.file`); `files.export` for Google-native docs and binary download + text extraction for the rest; `file_id` as external id; the **Changes API** (`startPageToken`) for incremental sync. **Restricted/sensitive scope → Google verification + possible security assessment (lead time).**

### Gmail
- **Works today:** nothing Gmail-specific.
- **Needs:** same Google project/OAuth client as Drive (add scope `gmail.readonly`); `messages.list` + `messages.get`, MIME → text parsing; `message_id` as external id; `historyId` for incremental. **`gmail.readonly` is a _restricted_ scope — heaviest Google verification (CASA security assessment); highest privacy sensitivity. Plan the longest runway here.**

> **Google note:** Drive + Gmail can share **one** Google OAuth client/project. Both are sensitive/restricted scopes requiring Google app verification — start that process early; it gates launch more than the code does.
