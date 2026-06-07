# Voice-App Connectors — Build Log & Handoff

**Date:** 2026-06-07 · **Status:** Milestone 1 shipped in the working tree —
**shared outbound foundation + the complete Fireflies connector + a Connections
UI.** Code-complete and self-verified (13/13 `node --check`, 12/12 new unit
tests, UI rendered in-browser). **Not yet applied/deployed** (DDL + env + deploy
are owned by you — see “Apply sequence”). Fathom / Granola / Zoom are scaffolded
as `coming-soon` and handed off with specs.

Built against [CONNECTORS_OAUTH_RECON.md](CONNECTORS_OAUTH_RECON.md). The recon’s
core finding held: the existing `api/oauth/*` is the inbound authorization server;
this is a brand-new **outbound** layer that does not touch it.

---

## The shape (how a transcript becomes a twin document)

```
connect (API key)                webhook: "Transcription completed"        cron (daily backstop)
      │                                   │                                         │
      ▼                                   ▼                                         ▼
 validate key ──▶ store ENCRYPTED ──▶ verify HMAC (x-hub-signature) ──▶  runFirefliesSync(incremental)
 (Fireflies      credential +              + load connection by ?c=<id>
  user query)    mint webhook secret       │
      │                                     ▼
      ▼                              getTranscript(id) ─▶ normaliseTranscript ─▶ text
 runFirefliesSync(backfill, budgeted) ───────────────────────────────────────────┐
                                                                                   ▼
                                          ingestConnectorItem(ctx, {provider, external_id, content})
                                                                                   │
                          ┌────────────────────────────────────────────────────────┤
                          ▼                          ▼                              ▼
            map hit + same hash          map hit + new hash            no map row
              → UNCHANGED (no-op)          → REPLACE same source         → addDocument (create)
                                            (replaceSourceId)              + content-hash backstop
                                                                                   │
                                                                                   ▼
                                          upsert connection_sources (provider, external_id) → source_id
```

`addDocument` does the rest unchanged: chunk → embed → Pinecone → parent summary
→ Library. **One transcript = one document, idempotent across re-delivery and
edits.**

---

## What shipped, by area

### Foundation (reused by every future connector — Fathom/Granola/Zoom/Notion/Drive/Gmail)
- **[schema/migrations/032-connectors.sql](schema/migrations/032-connectors.sql)** — two additive, reversible tables:
  - `connections` — one row per (tenant, provider, account); reversibly-encrypted
    credential + per-connection webhook secret + sync `cursor` (jsonb) + status.
  - `connection_sources` — the `(tenant, provider, external_id) → source_id` map,
    the primary idempotency key for sync (content-hash is the secondary backstop).
- **[lib/connector-crypto.js](lib/connector-crypto.js)** — **reversible** token
  encryption (AES-256-GCM, app key in `CONNECTOR_ENCRYPTION_KEY`). The inbound
  oauth_* tables hash (verify-only); connectors must replay the token, so they
  encrypt. Versioned ciphertext (`v1.<b64>`) → a future swap to Vault/KMS is a
  one-file change. **This is the “connector decision” the brief left open —
  decided: app-key, not Vault** (no DB-side setup, portable on Vercel, key never
  in the DB).
- **[lib/connections.js](lib/connections.js)** — tenant-scoped data-access for
  both tables (CRUD, encrypted secret get/set, cursor, status, the native-id map).
  `getConnectionForWebhook(id)` is the one unauthenticated read (the webhook is
  routed by `?c=<id>` and re-scopes to that row’s tenant).
- **[lib/connector-ingest.js](lib/connector-ingest.js)** — `ingestConnectorItem`,
  the idempotent upsert path (created / updated / unchanged / linked-existing).
- **[tools/storage.js](tools/storage.js)** — `addDocument` gained an optional
  `replaceSourceId` so an **edited** transcript (new content hash) updates its
  existing source in place instead of duplicating. Pre-030-safe (retries the
  source update without `content_hash` if the column isn’t there yet). The
  existing document tests still pass 8/8.

### Fireflies connector (the brief’s “first, proves the pattern”)
- **[lib/connectors/fireflies.js](lib/connectors/fireflies.js)** — GraphQL read
  client (Bearer key): `validateKey`, `listTranscripts` (paginated, `mine:true`),
  `getTranscript`, `normaliseTranscript` → text. Contract verified against
  docs.fireflies.ai at build time (endpoint, `user`/`transcripts`/`transcript`
  fields, webhook signature).
- **[lib/connectors/fireflies-sync.js](lib/connectors/fireflies-sync.js)** —
  budgeted, cursor-resumable backfill + incremental poll + single-item fetch for
  the webhook. **No Inngest dependency** (its keys may be unset) — runs inline
  under a soft deadline, checkpointing the cursor between pages.
- **[lib/connectors/registry.js](lib/connectors/registry.js)** — provider catalog
  (metadata, plan-gating, consent copy) + `LIVE_PROVIDERS` (only `fireflies`).

### API routes + webhook + cron
- **[api/connectors/index.js](api/connectors/index.js)** — `GET` the catalog +
  this tenant’s connections (status, last-synced, item counts).
- **[api/connectors/connect.js](api/connectors/connect.js)** — `POST` validate
  key → store encrypted → mint webhook secret → run a budgeted backfill → return
  the webhook URL + secret to paste into Fireflies. (`maxDuration` 300.)
- **[api/connectors/sync.js](api/connectors/sync.js)** — `POST` sync-now / continue.
- **[api/connectors/disconnect.js](api/connectors/disconnect.js)** — `POST` delete
  the connection: destroys the stored credential (revokes our copy) and cascade-
  deletes the map → ingestion stops. (OAuth providers will also call provider-side
  revoke here.)
- **[api/webhooks/fireflies.js](api/webhooks/fireflies.js)** — raw-body
  HMAC-SHA256 verify (`bodyParser` disabled), routed by `?c=<connectionId>`,
  per-connection secret, idempotent ingest. Accepts hex/base64 digest, with or
  without a `sha256=` prefix (the docs don’t pin the encoding).
- **[api/cron/connector-poll.js](api/cron/connector-poll.js)** — daily backstop;
  incremental sync (or backfill continuation) for every active connection.
- **[vercel.json](vercel.json)** — `/voice/connections` + `/connections` rewrites;
  `connector-poll` cron (daily 07:00); 300s `maxDuration` for connect/sync/poll.

### Connections UI (in the voice shell)
- **[public/connections.html](public/connections.html)** — native-feeling page
  (same shell/tokens as `/voice`): provider cards, connect-via-API-key, the
  webhook setup reveal (secret shown once), status / last-synced / item counts,
  Sync-now, Disconnect, plain plan-gating + honest consent framing. Linked from
  the voice nav ([public/voice.html](public/voice.html)).

### Tests
- **[tests/connectors.test.mjs](tests/connectors.test.mjs)** — crypto round-trip /
  tamper-detection / IV uniqueness / version rejection, and transcript
  normalisation (shape, speaker grouping, epoch-ms dates, id handling). **12/12.**

---

## ⚠️ YOUR turn — apply sequence (I cannot do these from here)

This environment has `SUPABASE_URL` + `SERVICE_ROLE_KEY` but **no**
`SUPABASE_ACCESS_TOKEN`/`PROJECT_REF`, so I can’t run DDL or deploy.

1. **Apply migration 030 first if not already live** — the connector idempotency
   guarantee (edit-in-place, content-hash dedupe) depends on `sources.content_hash`
   + the document model. Per project memory 030 was written but **not applied**.
   ⚠️ **Numbering collision (pre-existing, not introduced here):** both
   `030-document-model.sql` **and** `030-shared-answers.sql` exist, and two
   `031-*` files. Apply each by **filename**, not by number, and confirm which
   ones are already live before running. My migration is the unambiguous **032**.
2. **Apply migration 032** — `node scripts/run-migration.mjs schema/migrations/032-connectors.sql`
   (with `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` exported), or the
   Supabase SQL editor.
3. **Set env vars** (Vercel project settings):
   - `CONNECTOR_ENCRYPTION_KEY` — **required**. Generate:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - `CRON_SECRET` — optional but recommended (protects the poll cron).
4. **Deploy** — `npm run deploy:prod` (or `vercel deploy --prod`; a plain `git
   push` does NOT auto-deploy this project).
5. **Acceptance pass (needs a real Fireflies API key):**
   - Open `/voice/connections`, connect Fireflies with your key → past meetings
     backfill as documents (visible in the Library).
   - Copy the shown webhook URL + secret into **Fireflies → Settings → Developer
     Settings → Webhooks**.
   - Record a new meeting → its transcript auto-lands as **one** document within
     minutes (re-fire the webhook → still one, deduped).
   - Disconnect → confirm new recordings stop importing.

---

## 🚀 Kick off NOW (external lead-time — only you can, they need your accounts)

These gate launch more than code does — start them in parallel with the apply
sequence.

### Zoom app review (~4 weeks)
- Zoom Marketplace → **Build App → General/OAuth app**.
- Scopes (read-only): `cloud_recording:read` (recordings + transcript files),
  `user:read`. Add the **recording-completed** webhook event.
- Redirect/OAuth callback (reserve the path now): `https://<APP_URL>/api/connectors/zoom/callback`.
- Requirements to note in the listing: Pro-or-above plan + cloud recording on.
- Submit for review immediately; the 4-week clock is the critical path.

### Fathom OAuth app (register now)
- Fathom developer portal → register a **public OAuth app**.
- Redirect URI (reserve): `https://<APP_URL>/api/connectors/fathom/callback`.
- Scope: read recordings/transcripts. Capture **client_id** + **client_secret**
  → set as `FATHOM_CLIENT_ID` / `FATHOM_CLIENT_SECRET` when the connector lands.
- Fathom is where the **reusable outbound OAuth client** gets built (Notion /
  Drive / Gmail will reuse it) — so it’s the next milestone after Fireflies is
  accepted.

*(Granola: API-key like Fireflies, quick to add — but gate the UI on the Business
plan, already wired as a `plan_note`. Otter: out of scope, enterprise-only.)*

---

## Adding the next connector (the seam)
1. Flip its `status` to `available` + add to `LIVE_PROVIDERS` in
   [lib/connectors/registry.js](lib/connectors/registry.js).
2. Add `lib/connectors/<id>.js` (provider client + `normalise…`) and
   `lib/connectors/<id>-sync.js` (mirror `fireflies-sync.js`).
3. For OAuth providers: add `api/connectors/<id>/authorize.js` + `callback.js`
   (the new outbound OAuth client — built with Fathom), store access+refresh via
   `upsertConnection({ authType:'oauth', secret, refresh, tokenExpiresAt, scopes })`,
   and add a token-refresh-before-use step in the sync driver.
4. Route its webhook to `api/webhooks/<id>.js` and `disconnect.js` to call the
   provider’s token-revoke endpoint.
Everything below the provider boundary (encryption, the native-id map,
`ingestConnectorItem`, the UI, the cron) is already generic.

## Verification done here
- `node --check` on all 13 new/modified JS files — clean.
- New unit tests **12/12**; existing `document-model` tests still **8/8** after
  the `addDocument` change.
- Connections UI rendered in a browser (stubbed API) — connected + not-connected
  states, connect form, plan-gating, nav. Not browser-verified end-to-end: the
  live connect→backfill→webhook loop needs a real Fireflies key + applied 030/032
  + deploy, which this environment can’t exercise (that’s the acceptance pass).
