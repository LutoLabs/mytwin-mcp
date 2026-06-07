# Sharing, Workspaces & Permissioning — Ground-Truth Audit

**Date:** 2026-06-07 · **Scope:** read-only. Nothing built, migrated, or changed.
**Method:** live prod DB introspection (service-role, read-only), live prod HTTP probes
against `https://myaitwin.lutolearn.com`, full reads of the enforcement code, and both
isolation test suites run against prod.

> **Deploy note (important):** The working tree has many uncommitted/untracked files, but
> the audited surfaces are **live**. Verified by HTTP: `/account`→307→`/twin/profile`,
> `/twin` is the new home shell, `/twin/library` serves the share modal + contribute, and
> `/twin/profile` serves the Organisation-Workspaces UI. They deploy from the working tree
> without committing, so "uncommitted" ≠ "not shipped." The earlier "needs deploy" note is stale.

---

## TL;DR

The five-level email-sharing engine and the org-workspace backend are **real, correct, and
test-green** — isolation holds, retrieval enforces `can_use`, identity is deterministic. But
the thing the viral plan actually needs — **a link a logged-out stranger can open in a browser
to see shared content and be prompted to make their own twin — does not exist.** What's labelled
"Shared Twin" is an **MCP connector token** for Claude Desktop, not a web page. Separately, the
machinery has **near-zero production use** (0 shares, 0 invitations ever created) and the entire
security boundary is **application-layer only** (RLS is inert by design).

---

## 1. Schema reality in production

All workspace/permission/invitation/group tables **exist in prod**. Confirmed live by direct probe:

| Table | Status | Live rows | Key columns confirmed present |
|---|---|---:|---|
| `workspaces` | ✅ | 58 (56 personal, **2 org**) | `tenant_id, type, name, owner_id` |
| `workspace_memberships` | ✅ | 59 (**58 owner, 1 admin, 0 member, 0 guest**) | `workspace_id, user_id, role, invited_by` |
| `permissions` (grants) | ✅ | **0** | `level, subject_user_id, subject_group_id, object_item_id, granted_by` |
| `invitations` | ✅ | **0** | `email, workspace_id, item_id, level, token, accepted_at` (unified item+workspace) |
| `permission_groups` | ✅ | **0** | `id, workspace_id` — **`openness` ABSENT** |
| `permission_group_members` | ✅ | **0** | present, empty |
| `shared_mcp_tokens` | ✅ | **2** | `token_hash, token_prefix, revoked, last_used_at` |
| `knowledge.visibility` / `concept_pages.visibility` | ✅ | — | `private` / `sharable` |

**Migrations — applied vs pending (confirmed by column presence in prod):**
- **014 (visibility + shared_mcp_tokens): APPLIED** — `knowledge.visibility`, `concept_pages.visibility`, `shared_mcp_tokens` all present.
- **018 (workspaces-and-permissions): APPLIED** — all tables + all five-level `level` checks present.
- **028 (teamspace-openness): ❌ NOT APPLIED.** `permission_groups.openness` does not exist in prod. The parked ALTER is genuinely pending.

**What 028 actually is:** `ALTER TABLE permission_groups ADD COLUMN openness ('open'|'closed'|'private')`.
It is **Notion-style teamspace join-openness for Phase-3 permission groups — NOT** a per-item
public-visibility flag and **NOT** a public-link mechanism. It contributes **nothing** to viral
public sharing. (Backfills zero rows; there are no permission_groups.)

**The real public substrate is migration 014**, not 028: per-item `visibility` + `shared_mcp_tokens`.
But that path terminates in an MCP endpoint, not a web page (see §4).

---

## 2. Permission-enforcement depth

**Five-level model is enforced at the retrieval boundary.** `lib/permissions.js:26`
defines `USABLE_LEVELS = ['can_use','can_edit','full_access']`; `getAccessibleSharedItems`
filters grants `.in('level', USABLE_LEVELS)` ([lib/permissions.js:56-61](lib/permissions.js:56)).
So `can_view` and `can_comment` **never enter retrieval** — they are UI-only, exactly as designed.
Every error path **fails closed** (returns the empty set). `tools/retrieval.js` queries each
owner/workspace namespace separately and merges; group denials are subtracted post-query.

**Enforcement is application-layer only. There is no RLS backstop.**
- Per `schema/rls-policies-draft.sql` (verified live 2026-06-02): the 6 Phase-1 tables have
  **RLS ENABLED but ZERO policies** → default deny-all to non-service-role roles.
- **The app connects with the Supabase service-role key** ([lib/supabase.js](lib/supabase.js)),
  which **bypasses RLS entirely.** So RLS protects only direct dashboard / PostgREST / anon-key
  access — not a single application request.
- The draft policies reference `auth.uid()`, which is **never populated** (the app uses its own
  `jose` JWT, not Supabase Auth). **Even if applied, they would give the app zero protection.**
- **Policies that exist: none. Policies missing: all of them** — and they're inert by design until/unless auth moves to Supabase Auth.
- *Caveat:* I could not re-query `pg_catalog` live this pass (no admin SQL path and no anon key
  in env). The RLS state above is from the dated draft + the column-presence probe, not a fresh
  `pg_policies` read.

**Verdict:** depth is correct *at the app layer* and proven by tests, but there is **no
defence-in-depth**. For a product about to let strangers share into accounts, the entire boundary
is one forgotten `.eq('user_id', …)` away from a leak, with nothing underneath to catch it.

---

## 3. Per-email sharing, end to end + reachability

**Code: works end to end** — proven by `permissions.test.mjs` (share → recipient retrieval →
revoke → invite-new-email → accept → grant materialises). Endpoints: `POST /api/items/:id/share`,
`GET/DELETE /api/items/:id/permissions`, accept via `/api/invitations/:token`.

**UI reachability — the share modal is LIVE on the library detail view** (confirmed on prod):
- [public/library.html:1272](public/library.html:1272) `#detail-share-btn`; modal offers **all five
  levels including `can_use`** — *"Can use (their twin can draw on it)"* ([library.html:1582-1586](public/library.html:1582)).
  (An earlier sub-finding that only 3 levels were offered was wrong — all five are present.)
- The org-workspace + sharing UI was **migrated out of the retired `account.html` into
  `profile.html`** — it is **not stranded**. `account.html` the file still exists but every route to
  it 307-redirects to `/twin/profile`.

**The reachability gap that matters:** the share affordance exists **only** on the library detail
view. It is **absent from concept pages** (`concept.html` — no share/visibility control at all) and
**absent from chat** (`twin.html`). Concept pages are the most natural thing to share, and you
cannot initiate a share from one.

---

## 4. Public / link-based sharing — the viral unit

**Verdict: NOT BUILT.** A non-user cannot open a link and view a shared item / concept / twin,
and nothing prompts them to create a twin.

What exists and why it isn't the viral loop:
- **"Shared Twin" = an MCP connector token, not a web view.** The profile button literally reads
  *"Generate shared **MCP** link"* ([profile.html:421](public/profile.html:421)) and produces
  `…/mcp/shared/<token>` ([profile.html:1158](public/profile.html:1158)). That endpoint is a
  JSON-RPC MCP server — *"Suitable for Claude Desktop 'Add custom connector'"*
  ([api/mcp/shared/[token].js:7](api/mcp/shared/[token].js:7)). Opening it in a browser yields no
  page, no content, no CTA. It exposes `sharable` items to an MCP client — useful, but it is a
  power-user integration, **not** a growth mechanic. (2 such tokens exist in prod.)
- **Concept pages are auth-gated**, not public: `concept.html` client-redirects to `/twin` when
  there's no session token. There is no token-based public render of a concept page.
- **No public HTML surface, no "create your own twin" CTA, no OG/social preview, no viewer→signup funnel.**

**What 028 contributes to this:** nothing (it's teamspace openness).
**What the substrate offers:** migration 014's `visibility='sharable'` flag + tokens — the data
model can already mark things public; what's missing is a *page that renders them to a stranger.*

---

## 5. Org-workspace flows in the current shell

**Backend: complete and correct.** ~21 HTTP operations across `api/workspaces/**` + 2 MCP tools
(`list_workspaces`, `contribute_to_workspace`). Roles `owner/admin/member/guest` are enforced on
every mutating endpoint (`MANAGE_ROLES`, `CONTRIBUTOR_ROLES`). **Namespace isolation is correct:**
each org workspace gets its own tenant → its own Pinecone namespace (`tenant_<id>`); members read a
workspace namespace only via `getMemberWorkspaces`, which validates membership and skips the user's
own tenant. **Contribution is a one-way copy + re-embed** into the workspace namespace
([lib/contribution.js](lib/contribution.js)) — the asymmetric ratchet (org content never flows back
into a personal tenant) holds.

| Step | Backend | UI surface | Verdict |
|---|---|---|---|
| Create workspace | `createOrgWorkspace` | profile.html `#ws-create-btn` | **WORKING** |
| Invite member (existing/new email) | `addMember` | profile.html invite UI | **WORKING** (code); **never exercised in prod** |
| Accept invite → membership | `acceptWorkspaceInvitation` (atomic, single-use) | `/api/workspaces/invitations/:token/accept` | **WORKING** (code) |
| See roles | `listMembers` | profile.html / home switcher | **WORKING** |
| Contribute personal item → workspace | `contributeToWorkspace` | library.html `#detail-contribute-btn` | **WORKING** |
| Scope chat/library/brain to workspace | `getMemberWorkspaces` in retrieval | home.html space-switcher | **WORKING** (code) |
| Teamspace **openness** (open/closed/private) | `createGroup` | profile.html control (live) | **DORMANT / no-op** — see below |

**Reality check from prod data:** only **2 org workspaces** exist, and there are **0 `member` and
0 `guest` rows** — every membership is `owner`/`admin`. **The multi-member invite → accept →
contribute → scoped-retrieval loop has never run with real members in production.** It passes in
the test harness; it has no real-world miles.

**Latent mismatch (low severity):** profile.html ships the teamspace **openness** control
(Open/Closed/Private), but the `openness` column isn't in prod (028 unapplied). `createGroup`
handles this gracefully — it retries the insert without `openness` and downgrades to `'closed'`
([lib/groups.js:54-74](lib/groups.js:54)). So choosing "open"/"private" is a **silent no-op**, not a
crash. Phase 3 is dormant anyway (0 groups), so impact today is nil.

---

## 6. Identity dependency (the A2 fix)

**Deterministic — confirmed.** `requireTenant` ([lib/anon.js:116-140](lib/anon.js:116)) resolves an
authenticated **session cookie first and never honours an anon token on a request that also has a
session** ("once a user signs in we never honour an anon token"). `ctx.tenantId` is read
server-side from the `users` row, so it can't be spoofed by the client. The anon token is a signed
JWT (same `JWT_SECRET`), not a raw tenant id. Since every permission filter keys off this
`ctx`, the foundation it sits on is sound.

---

## 7. Test status

| Suite | What it covers | Result |
|---|---|---|
| `tests/permissions.test.mjs` | Cross-tenant isolation + 5-level sharing (share, retrieve, revoke, invite-new-email, accept, org member vs non-member) | **9 / 9 PASS** |
| `tests/creation-scoping.test.mjs` | Org-workspace knowledge bucket in `searchForCreation`; skill bucket stays personal | **5 / 5 PASS** |
| `scripts/security-tests.mjs` | Input-validation / UserError paths (no DB) | **42 / 42 PASS** |

All green against current code + live prod. **Note on the "17/17 cross-tenant suite" from the 2-June
record:** no file by that count exists today — `permissions.test.mjs` *is* the cross-tenant suite and
now has 9 tests. The number changed; the coverage is intact and passing.

---

## The four buckets

### ✅ Built and wired (live + working)
- Per-item email sharing, all 5 levels incl. `can_use`, end-to-end — reachable on **library detail view**.
- Permission-aware retrieval enforcement (`can_use` gate, fail-closed) — app-layer.
- Deterministic identity resolution (session > anon).
- Org-workspace backend: CRUD, role enforcement, per-workspace namespace isolation, one-way contribution.
- Org-workspace management UI on `profile.html` (create / invite / manage) + home space-switcher + library Team/leaderboard view + library contribute.
- Shared-MCP-token read-only surface (Claude Desktop connector).
- Migrations 014 + 018 applied; new shell + `/account`→`/twin/profile` routing deployed.

### 🟠 Built but unreachable / mis-placed in the current shell
- Sharing can be initiated **only** from the library detail view — **no share/visibility control on
  concept pages or chat** (the surfaces users most want to share from).
- `account.html` is dead weight (file present, every route redirects away). Its UI was successfully
  migrated, so nothing is *stranded* — but the file should be deleted to avoid confusion.

### 🟣 Built but dormant
- **Phase-3 permission groups / teamspaces:** schema present (minus `openness`), UI present in
  profile.html, but `permission_groups = 0`; logic short-circuits when empty.
- **Teamspace openness (028):** UI live, **column not applied** → silent no-op.
- **RLS policies:** draft only, unapplied — and inert under the service-role + custom-JWT model.
- **Org workspaces in practice:** 2 exist, 0 real members — the feature is effectively unused.
- **Per-email sharing in practice:** `permissions = 0`, `invitations = 0` — **never used in prod.**

### 🔴 Not yet built
- A **public, logged-out web view** of a shared item / concept / twin (the viral unit).
- A **"create your own twin" CTA** on that view + a viewer→signup conversion funnel.
- **Public concept pages** (token-based render of `concept.html` for non-users).
- **Social/OG preview metadata** for share links.

---

## Ranked gaps: today → a working public-share viral loop

1. **No public web view of any shared unit.** This *is* the missing viral loop. Needs an
   unauthenticated route + page that renders a `sharable` item / concept / twin to a stranger.
2. **No "create your own twin" CTA / conversion funnel** on that view. The anon-twin substrate
   already exists (`/twin` provisions an anon tenant) — wire the viewer into "claim/forking this."
3. **Public concept-page render.** Concept pages are the natural viral artifact but are auth-gated;
   add a token-scoped public render path.
4. **Share affordance on concept pages and chat.** Even private 5-level sharing can't be started
   from the surfaces people actually want to share.
5. **028 vs UI mismatch.** Either apply 028 or hide the openness control until Phase 3 ships.
6. **Defence-in-depth (RLS).** See P0 below.

---

## P0 flags (data-isolation / permission-leak)

- **No active leak found.** Isolation is proven: `permissions.test.mjs` 9/9, `creation-scoping`
  5/5, namespace isolation correct, fail-closed throughout, identity deterministic. As of today the
  data boundary holds.
- **P0-class fragility — the boundary is application-layer only, with no RLS backstop.** The app
  runs as service-role (bypasses RLS), and the draft policies are inert (`auth.uid()` never set).
  For a product about to invite strangers to share into each other's accounts, a single missing
  filter in any future retrieval/read path leaks across tenants with nothing underneath to stop it.
  **Treat "ship real defence-in-depth before opening sharing to strangers" as P0** — either move the
  shared/public read paths onto user-scoped DB roles with real RLS, or gate every cross-tenant read
  behind a single audited chokepoint with its own tests.
- **Lower-severity, not leaks:** shared-MCP-token URLs are unexpiring bearer links (rate-limited
  50/hr) — acceptable but worth an expiry/rotation story before scale; the 028/openness control is a
  silent no-op, not a leak.

---

## One-paragraph read

The engine is in far better shape than the storefront: five-level sharing and org workspaces are
correctly built, namespace-isolated, fail-closed, identity-deterministic, and green across 14
isolation tests — but the machinery has essentially **zero production miles** (0 shares, 0
invitations, 0 real workspace members ever), the only "public" surface is a Claude-Desktop MCP
token rather than a web page, and the entire security boundary rests on the application layer with
no RLS underneath. So the distance to a *safe, functional* sharing loop is short on correctness and
long on the two things that matter for launch: there is **no viral artifact at all** (no logged-out
web view, no "make your own twin" CTA — that's net-new build, not a wiring fix), and there is **no
defence-in-depth** to make stranger-to-stranger sharing safe at scale. Build the public view + CTA,
add a real cross-tenant read backstop, and put live miles on the existing invite/contribute flows —
then the loop is both functional and safe.
