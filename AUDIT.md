# Luto / MyAITwin — Pre-Launch Audit

_Branch: `pre-launch-audit` (off `4872849`). Pass 1 = audit (read-only). Pass 2 = only the gated safe fixes below._

---

## 0. Closing summary (read this first)

**Fixed tonight (2 commits, both verified safe):**
- **`20f8bc6` — fix (a):** `/account` 404. `profile.html` "Manage workspaces" linked to `/account` (no such route); changed to `/account.html` to match every other surface. One line, frontend-only.
- **`e4c9fa0` — fix (d):** leaked `[X PATTERN]` tokens. `twin.html` stripped `[concept page N]`/`[item N]` but not the `[PRINCIPLE PATTERN]`/`[SKILL PATTERN]` tokens that `concept-context.js` injects. Added a precise all-caps strip (no `/i`, so it can't touch "design pattern"). One line, frontend-only. Self-tested.

**Deliberately left for review (did NOT fix), with reasons:**
- **(b) logo → "Get started free":** could not reproduce as described. **Every** real logo links to `/` correctly (twin, library, profile, account, concept, invite). The real issue is that `/` is the *marketing* page, so a **logged-in** user clicking the logo lands on the signed-out CTA page. The fix (logo → app-home for authed users) is a **product judgment call** and overlaps the in-progress `home-next` work — not a localized safe fix. (`home-next.html` also self-links its logo, but it is **untracked WIP** I won't touch.)
- **(c) skill-codify nudge on throwaway drafts:** the instruction lives in `api/twin/turn.js` `chatInstruction()` (creation mode) — a **system-prompt-zone** change, and "throwaway" needs a judgment threshold. Review-only by the gate. Exact proposed fix below.
- **(e) chat blind to its own surfaces:** also `chatInstruction()` capability text — **system-prompt-zone**. Review-only. Exact proposed fix below.
- All **architecture refactors** (god-function `turn.js`, duplicated helpers, retrieval duplication) and all **security/data-model** items — out of gate by design.

**Top 5 highest-leverage optimisations to do first tomorrow** (full roadmap below; all S-effort except where noted):
1. **P1 — kill the 100-row count refetch** in stage inference (`head:true` count). Every turn lighter + faster. _S._
2. **D1 — store-confirmation toast + pulse** (replace the "In. Filed." hard cut). Every capture feels premium. _S._
3. **B1 — Anthropic prompt caching** on the system + concept/knowledge blocks. ~20–30% token & latency on chat. _S, measure spend first._
4. **E1 — consolidate the duplicated helpers** (`sbError` ×3, `formatSource` ×2 with a real null-handling divergence) into `lib/knowledge-helpers.js`. Safest elegance win; removes a latent bug. _S._
5. **P3 — parallelise multi-item ingestion** (`addFromUrl`/`addVoiceNote` → batched like `addDocument`). 5-item URL ingest ~2s → ~0.4s. _M._
   _Bonus standout (free power): **B2** — once reconciliation Phase 3 writes `item_links`, render them as typed edges on the hypergraph — the brain becomes a real knowledge graph for almost no effort._

**Honest verdict:** **This codebase is in good shape to keep building on and to launch this weekend.** The bones are sound — clean `tools/` / `lib/` / `api/` separation, a single ingestion chokepoint, a solid signed-JWT auth model, *tested* cross-tenant isolation, SSRF guards, real cost guardrails, and one genuinely exemplary subsystem (`lib/reconciliation/*`) to copy from. There are **no structural blockers.** The optimisation lens surfaced no alarms either — the inefficiencies are ordinary (a redundant count query, an extra Haiku hop, serial ingestion loops), all cheap to fix, none load-bearing. The genuine pre-launch gaps are (1) thin automated test coverage, (2) a few prompt-polish items (b/c/e), and (3) safe-to-defer refactors. Launch is reasonable; everything below is a prioritised menu, not a wall.

---

## 1. Architecture & structure

**Overall: well-organised.** `tools/*` = MCP tool implementations, `lib/*` = shared helpers, `api/*` = thin routing wrappers, `public/*.html` = per-surface frontends. A request is traceable end-to-end. The single ingestion chokepoint (`tools/storage.js#addKnowledge`) and the Inngest event fan-out (`twin/item.stored` → compile / skill-detect / reconcile) are clean designs.

**🟠 Should-fix (post-launch refactors — NOT gate-eligible, NOT blockers):**
- **`api/twin/turn.js` is an ~880-line "god function"** — classifier, spell handling, 4 chat modes, dual retrieval, drift, skill-gap, SSE, audit, all inline. Hard to test/change safely. Direction: extract classifier, spells, SSE, stage to `lib/`. (Refactor, not a bug.)
- **Duplicated helpers:** `sbError` defined in both `tools/storage.js` and `tools/management.js`; source-formatting logic duplicated (and the two copies handle null `source_type` differently). Extract to a shared `lib/` helper.
- **Retrieval duplication:** `searchTwin` / `getByType` / `getByTag` in `tools/retrieval.js` repeat the own-namespace + shared + workspace merge/rank/fetch pattern (~200 lines). Extract a common helper.
- **Auth-pattern inconsistency:** some endpoints use `runTwin`/`requireTenant` (session-or-anon), others `requireAuth` (session-only), with three different "unauthorized" message styles. Not a bug, but document the contract and normalise messages.

**🟢 Nice-to-have:** placeholder logic coupled to the profile surface; per-page inline JS (no shared modules) means voice/card logic is copy-pasted; minor concept-page re-querying between library and profile.

**Dead/orphaned:** none critical found. `api/auth/signin.js` looks legacy vs `auth/request`+`auth/claim`; worth confirming before launch but harmless.

---

## 2. Bugs & breakage

| # | Bug | File:line | Root cause | Fix | Gate |
|---|-----|-----------|-----------|-----|------|
| a | `/account` 404 | `profile.html:402` | links `/account`; no such rewrite; convention is `/account.html` | → `/account.html` | ✅ **FIXED** `20f8bc6` |
| d | `[X PATTERN]` token leaks into chat | `twin.html:1811` | strip covers `[concept page N]`/`[item N]` only; `concept-context.js:88` emits `[FLAVOUR PATTERN]` | add `/\[[A-Z]+ PATTERN\]/g` | ✅ **FIXED** `e4c9fa0` |
| b | logo → "Get started free" | all logos = `/` (correct); `/` is marketing | logged-in users sent to signed-out page; `home-next.html:195` self-links (untracked WIP) | logo → app-home for authed users | 🚫 **review** (judgment + WIP overlap) |
| c | skill nudge on throwaway drafts | `api/twin/turn.js:70` + `tools/retrieval.js` skill-gap | fires whenever a creation request has no matching skill, regardless of output size | gate the nudge to substantive output only | 🚫 **review** (system-prompt zone + judgment) |
| e | chat blind to Brain/Library/concepts | `api/twin/turn.js:58` (capability text) | capability enumeration omits the Brain/hypergraph/concept-pages and Library | add them to the capability line | 🚫 **review** (system-prompt zone) |

**Part B — other defects:** the bug-hunt found **no additional broken routes, dead nav links, or unhandled-rejection hazards** on the main paths. Navigation hrefs verified intact; API handlers wrap errors. (Two agents independently reported a clean Part B.)

---

## 3. Robustness & quality

**🟠 Should-fix (review-only or non-trivial — not fixed tonight):**
- **SSE error masking** (`api/twin/turn.js`): a mid-stream failure emits an `error` event then `done` over an already-200 response, so a client can read `done` and treat a partial/failed turn as success. Real but the fix touches the core streaming path → review.
- **`content_override` size**: flagged by an agent as uncapped — **verified NOT a blocker**: it is stored only via `addKnowledge`/`confirm-store`, which enforce `assertLength` (50k). The proposal display is bounded at use. Low risk.
- **Inngest backpressure**: `reconcileItemJob` is `concurrency: 3` (good); `nightlyLintJob` iterates all tenants without pagination (fine at current scale, a timeout risk past a few thousand tenants).
- **No DB-query timeouts / circuit breakers** on the API paths; a hung query hangs the response.

**🔴 for launch confidence (not a code fix): test coverage is thin.** Only `tests/permissions.test.mjs` + `tests/creation-scoping.test.mjs` and a set of manual `scripts/*-e2e.mjs` harnesses. No CI test suite for error paths or endpoints. This is the single biggest "are we sure" gap — recommend a handful of integration tests (401/403, permission denial, cross-tenant probe, a happy-path turn) before or just after launch.

**Frontend states:** error/empty/loading handling is driven by inline JS and is mixed — the library and profile pages degrade gracefully on some failures (e.g. the upvotes-table fallback, the hypergraph empty state), but there is no global "API failed, retry" affordance.

---

## 4. Security & data integrity (report-only — nothing changed)

**Strong, with one structural caveat:**
- **No exposed secrets.** `.env.local`/`.env` gitignored, never committed; no secret values in tracked source or logs. ✓
- **Auth checks present everywhere** material — all `/api/twin/*`, `/api/workspaces/*`, `/api/library/*` go through `runTwin`→`requireTenant` (session cookie or signed anon JWT). Workspace mutations additionally reject anonymous. Admin endpoints use a constant-time token check. No unguarded mutation endpoints found.
- **Cross-tenant isolation: tested.** `api/admin/test-cross-tenant.js` exercises ~15 retrieval/mutation paths with synthetic tenants; queries are consistently `.eq('user_id')`/`.eq('tenant_id')`; shared/workspace reads are permission-resolved first. No leakage path found. (Today's `listWorkspaceItems` group-restriction fix is part of this.)
- **No SQL injection surface** — Supabase query builders + one parameterised RPC; no string-interpolated SQL.
- **🟠 RLS is deny-all, defensive-only.** Per `schema/rls-policies-draft.sql`, the app uses its own JWT (not Supabase Auth), so `auth.uid()` is never set and **all** access is via the service-role key (bypassing RLS). The real boundary is the app layer (JWT + explicit tenant filters), which is sound and tested. **Caveat for review:** RLS being enabled with zero policies means any *future* direct-client/Supabase-Auth path would be deny-all until policies are written. Keep `rls-policies-draft.sql` for that day. **Not a launch blocker; do not change before launch.**

All of §4 is **review-only** per the gate — flagged, unchanged.

---

## 5. Launch-readiness checklist

**Blockers (must be true to launch):**
- [x] Auth + cross-tenant isolation sound and tested — **yes** (verified).
- [x] No exposed secrets — **yes**.
- [x] Core paths (chat, ingestion, library, workspaces) function — **yes**.
- [x] The two trivially-safe live bugs fixed — **yes** (a, d).
- [ ] **Merge `pre-launch-audit` → deploy** so the fixes go live (the two safe fixes are on the branch only; not yet on `main`/prod).
- [ ] **Decide (b):** where the logo points for logged-in users (small product call; affects every page).

**Would-be-nice (not blocking this weekend):**
- [ ] Apply (c) and (e) prompt polish (both one-line edits to `turn.js` capability/creation text — see below).
- [ ] A few CI integration tests (error paths, permission denial, cross-tenant).
- [ ] SSE error signalling so failed turns don't read as success.
- [ ] Paginate `nightlyLintJob`; add query timeouts.
- [ ] The architecture refactors in §1 (post-launch hygiene).

---

## 6. NON-NEGOTIABLE SAFE FIXES (the gated set)

Only these passed all five gate conditions (definite bug · small/localised · reversible · not a review-only zone · confident). **Both applied.**

1. **(a)** `public/profile.html` — `href="/account"` → `href="/account.html"`. → `20f8bc6`
2. **(d)** `public/twin.html` `renderCitations` — add `.replace(/\[[A-Z]+ PATTERN\]/g, '')`. → `e4c9fa0`

**Exact proposed fixes for the review-only items (for tomorrow, NOT applied):**
- **(c)** In `api/twin/turn.js` creation-mode block (~L70): only append the "worth saving this as a starting point?" line when the produced output is substantive — e.g. gate on `skillGap.count`/output length, or instruct: _"Only suggest saving a skill when the output is a real reusable artifact (a proposal, an essay, a structured doc) — never for a tweet, a one-liner, or a throwaway draft."_
- **(e)** In `api/twin/turn.js` capability line (~L58): add the missing surfaces — _"…explore your Brain (the live hypergraph and synthesised concept pages) to see patterns across your thinking, and browse and manage everything in your Library."_
- **(b)** Decide the logged-in logo target (likely `/twin` or the brain home), then change `href="/"` → that, on the authed surfaces only. Also fix `home-next.html:195` (`/twin/home-next` → `/`) once that prototype is committed.

---

---

# OPTIMISATION ROADMAP (tomorrow's work — nothing here changed tonight)

Ranked by leverage (impact ÷ effort). Effort S/M/L. Optimisations and refactors **never** pass the safe-fix gate, so all of this is for tomorrow, executed carefully.

## A. Performance & power (make the hot paths faster/lighter)

| # | What | Better method | Effort | Gain | Risk |
|---|------|---------------|--------|------|------|
| P1 | **Stage-inference refetches up to 100 full rows just for a count** (`turn.js` ~L797 → `management.js#listRecent` does `select('*',{count:'exact'}).limit(100)`) | Use a head-count: `select('id',{count:'exact',head:true})` — no rows, no content. Verified real (I wrote the `total_count` path). | S | 20–100 KB + ~50–150 ms off **every** turn on large twins | none |
| P2 | **A second Haiku call on the latency-critical chat path** — `concept-context.js` relevance-filters concept pages with its own Haiku call (when >4 pages), so there are **2 LLM round-trips before the first streamed token** | Fold concept-relevance into the main classifier's JSON output, OR raise the keyword-only threshold (≤8), OR go embedding-based (B3) | M | ~50–100 ms latency + ~20% Haiku cost off chat turns | low — validate picks vs current Haiku |
| P3 | **Serial multi-item ingestion** — `addFromUrl`/`addVoiceNote` loop `await addKnowledge` per item (each = autoTag+embed+insert+upsert); `addDocument` already batches with `Promise.all` | Apply the same `Promise.all`/batched pattern to the URL + voice paths | M | 50–70% faster multi-item ingest (5-item URL ~2s → ~0.4s) | low |
| P4 | **recompileStalePages scans all items per stale page** (O(N×M)) | Precompute per-item term sets once, intersect per page (O(N+M)) | M | ~100 ms per recompile burst | none |
| P5 | **`select('*')` everywhere in retrieval + listRecent** pulls `content`/`pinecone_id`/`version` the caller doesn't use | Select only needed columns | S | 30–50 KB per search/turn (mobile) | none |
| P6 | **Indexes** (report-only — schema = review zone, do NOT change tonight): hot queries filter `tenant_id + user_id + created_at` but the index is `(tenant_id, created_at)`; `getByTag` has no GIN on `tags` | Add `(tenant_id,user_id,created_at desc)` + `GIN(tags)` — for the review-only DB pass | S | 10–30% on hot queries at scale | review-only |

## B. Better methods & capability uplift

| # | What | Better method | Effort | Gain |
|---|------|---------------|--------|------|
| B1 | **No prompt caching** on the heavy system prompt + concept/knowledge blocks | Anthropic `cache_control: ephemeral` on the stable system block — cache across turns in a session | S | **20–30% token + latency** on chat (measure spend first) |
| B2 | **Hypergraph edges are tag-overlap only** (`api/profile/hypergraph.js`) | Once reconciliation Phase 3 writes `item_links`, draw **typed** edges (elaborates/supersedes), colour + hover by kind. The brain becomes a real knowledge graph, not a tag cloud. **The data is already being produced in shadow.** | S (post-Phase-3) | **High** power + delight — ties two systems together for nearly free |
| B3 | Concept-relevance filter is an LLM call | Embed concept title+summary on compile (own Pinecone namespace); pick relevant pages by cosine, fall back to Haiku only on low confidence | M | cheaper + faster concept context |
| B4 | Near-duplicate stale-marking is keyword-based | The reconciliation engine already computes nearest-neighbour scores — mark an old item stale when a new one lands at >0.97 sim. Unifies cruft-flagging in one place | S–M | proactive dedup signal |

## C. Elegance & strength (highest-leverage simplifications for safe future building)

| # | What | Better method | Effort | Risk |
|---|------|---------------|--------|------|
| E1 | **Duplicated helpers** — `sbError` defined 3× (`storage.js`,`management.js`,`schema-tools.js`), `formatSource` 2× with **divergent null-handling** (a latent bug) | One `lib/knowledge-helpers.js`, canonical versions, import everywhere | S | negligible — pure functions |
| E2 | **`turn.js` ~880-line god function** | Extract `handlers/{classifier,spells,retrieval-stage,streaming,drift}.js` + a thin orchestrator. Lock behaviour with tests first, then move (no logic change) | M | low if tests-first |
| E3 | **Retrieval triplet** (`searchTwin`/`getByType`/`getByTag`) repeats ~200 lines of permission-aware merge/rank/fetch | Extract `fetchAccessibleResults(ctx,{ids})` — own+shared+workspace once | M | low — test the permission edges |
| E4 | **Per-page inline JS** (twin/library/profile = 1k–3k lines each) duplicate `api()`, card rendering, markdown, auth-sync | Shared `public/modules/*.mjs` (static ES modules, no bundler) | M–L | medium |
| E5 | **Two auth contracts** (`runTwin`/`requireTenant` vs `requireAuth`) | One `getRequestContext(req,{requireAuth})` with caps/audit hooks | M | low |
| — | **`lib/reconciliation/*` is the model to copy**, not refactor — clean module split, shadow+reversible from day one. Extend new subsystems this way. | — | — | — |

## D. Delight (cheap, calm/premium — the small moments)

| # | What | Effort | Leverage |
|---|------|--------|----------|
| D1 | **Store-confirmation moment** — replace the "In. Filed." hard cut with a quiet "✓ Saved" toast + a soft card fade-out + the ack fading up. Every capture should feel good. | S | **9/10** |
| D2 | **Kind empty states** — "Nothing on that yet" → an invitation ("What's the first thing worth keeping?") with a calm centred mark, per mode | S–M | **9/10** |
| D3 | **Library skeleton stagger** — fade cards in with a small per-card delay (gradual abundance, not a dump) | S | 7/10 |
| D4 | **Brain page life** — fade nodes in on load + reuse the `home-next` breathing-halo hover; pairs with the surfacing moment just shipped | S | 7/10 |
| D5 | **Compile-concepts ack** — a "compiling…/✓ compiled" toast (needs a tiny status endpoint) so the async job is visible | M | 5/10 |

---

_End of audit + optimisation roadmap. Two safe fixes applied on this branch (`20f8bc6`, `e4c9fa0`); all optimisations and review-only items left for tomorrow per the gate._
