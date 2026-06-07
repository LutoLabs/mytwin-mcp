# Step 0 — Gap Report: the calm "complete home" preview page

Audit only. No code written. Stop for sign-off before Phase 1.
All findings verified against the live prod tenant `21733441` (Piotr's twin).

## Headline corrections to the brief's assumptions (read these first)

1. **No Next.js, no React.** The app is plain static HTML in `public/` + Vercel
   serverless functions in `api/`, with routes declared in `vercel.json` rewrites.
   There is no app/pages router, no JSX, no `react` dependency. → The hero cannot
   be a React `<MindGraphHero/>` with `useEffect`; it must be a **self-contained
   vanilla module** (SVG + `requestAnimationFrame`), which is exactly what the
   brief's Appendix loop already is. Same idea, different packaging.

2. **There are TWO Luto palettes, and the brief wants the one the `/twin` app
   does NOT use.** The `/twin` app pages (`twin.html`, `profile.html`,
   `library.html`) are a **dark** theme (`--bg:#05060e`, yellow `#FFD400`). The
   **cream/amber** surface the brief describes is the *onboarding* surface
   (`create.html`, `account.html`, `docs.html`): paper `#FDFCFA`, amber `#FFE34A`,
   ink `#0F0E0D`, muted `#857C6E`, lines `#E8E2D4`, neo-brutalist borders. This is
   a real, native Luto token set — just not the one used elsewhere under `/twin`.
   **Decision needed (Open Q below): cream home that visually departs from the
   other `/twin` pages, or dark home that matches them?** The brief's language
   ("cream/off-white background, amber, calm") points to cream. I recommend cream,
   reusing the `account.html`/`create.html` tokens + header, not the dark shell.

3. **The demo tenant is data-rich, not cold-start.** 69 items, 9 concept pages,
   0 pending reviews, 69 ELABORATION decisions. So the rich variant demos against
   Piotr's tenant; cold-start needs a separate low-data tenant.

---

## A. Framework & routing

- **Stack:** static HTML (`public/*.html`) + Vercel functions (`api/**/*.js`).
  No React/Next (confirmed: no `react` in `package.json`, no app/ or pages/).
- **Routes:** `vercel.json` → `rewrites`, e.g.
  `{ "source": "/twin/profile", "destination": "/profile.html" }`,
  `{ "source": "/twin/library", "destination": "/library.html" }`.
- **Add a new route without touching existing ones:** create
  `public/home-next.html` + add ONE rewrite line
  `{ "source": "/twin/home-next", "destination": "/home-next.html" }`. This is
  additive (the `rewrites` array; NOT the `functions` block, so the 50-function
  cap is irrelevant). No existing rewrite/redirect changes.
- **Auth/tenant context:** the `ctx = {userId, tenantId, isAnonymous}` the brief
  expects is **server-side**, created by `runTwin`/`requireTenant` inside API
  routes. The static page itself has no ctx; it **bootstraps identity client-side**
  via `GET /api/auth/session` → `{ valid, is_authenticated, email, user_id, tenant_id }`
  (`api/auth/session.js`). The profile/graph endpoints it then calls use
  `requireAuth(req)` (the `mt_session` cookie) and **default to the requester's
  personal workspace** — the page passes no workspace id. firstName for the
  greeting comes from `/api/profile` → `owner.name` (session only carries email).

## B. Branding tokens (cream surface — recommended reuse set)

From `account.html` / `create.html` / `docs.html`:
- surface/paper `#FDFCFA`; warmer panel `#F9F8F4`; lines `#E8E2D4`
- ink `#0F0E0D`; muted ink `#857C6E`
- amber accent `#FFE34A` (hover `#F5C500`) — brief's `#EF9F27` is close; use Luto's
- neo-brutalist motif: `1.5px solid #0F0E0D` borders, hard `2px/4px 0 #0F0E0D` shadows
- serif display: **Fraunces** (the Luto serif, loaded in `profile.html`); mono
  labels: **Spline Sans Mono** (dark app) or **JetBrains Mono** (cream pages)
- logo mark/lockup: the `.logo`/`.logo-mark`/`BY LUTO` pattern (reusable as-is)

No existing Button/Card component library — pages are hand-rolled inline styles.
"Reuse components" = reuse the **markup+token patterns** (header lockup, card
shapes, mono label style), not an import. Smallest footprint: copy the cream
header + token block into the new page.

## C. Data fetchers — what exists, what's a gap

| Need | Source | Status |
|---|---|---|
| item count + concept count (greeting) | `GET /api/profile` → `stats.items`, `stats.concept_pages` (also on `/api/profile/hypergraph` → `workspace.stats`) | ✅ reuse |
| breakdown by type (room value lines) | `GET /api/library/stats` → `totalItems`, `itemsByType{}` | ✅ reuse |
| concept pages count + list (title/summary) | `GET /api/library/concepts` → `{ knowledge[], skills[], total }`, each `{id,title,summary,...}` | ✅ reuse (NOT a gap — prod uses flavour `knowledge`/`skills`, 9 rows; the migration-010 `thinking/craft` note is stale) |
| **hypergraph (hero)** | `GET /api/profile/hypergraph` → `{nodes[],edges[],domains{},workspace}` | ✅ reuse — THE graph source |
| library deep-link by type | `GET /api/library/items?type={t}&sort=recent` | ✅ reuse |
| shared-with-you / team brains | `GET /api/workspaces` (`listMyWorkspaces`) and/or `GET /api/library/shared.js` | ✅ reuse (confirm which gives the "shared with you" count) |
| **serendipity (recent ELABORATION)** | reconciliation_decisions exists (69 ELAB rows) but only an **aggregate** endpoint exists (`/api/twin/reconciliation-stats`) | ⚠️ **GAP — needs a small additive read endpoint** |
| **review-queue presence** | `review_items` table exists (0 pending now) but **no read endpoint** | ⚠️ **GAP — needs a small additive read endpoint** |

**Graph data shape** (drives the hero):
`nodes[] = {id, title, type, provenance, tags, degree, created_at}`;
`edges[] = {i, j, strength}` (i/j index into nodes);
`domains{} = { "<Domain name>": { color:"0xRRGGBB", node_ids:[...] } }` — 6 domains,
colours are **three.js `0x` strings tuned for the dark hero** (e.g. `0xFFD400`,
`0xFF3D8B`). For an SVG cream hero: parse `0x`→`#`, and likely **remap to muted
cream-surface variants** (the vivid dark-bg colours will glare on `#FDFCFA`).
Serendipity edge = the two `incoming_item_id`/`candidate_item_id` of the recent
ELABORATION, matched to node `id`s in the sampled set.

**Type vocabulary (real, from prod — NOT `skill`/`knowledge`):**
`principle 16, method 16, position 15, theme 10, resource 8, template 3, voice 1`.
The simplified two-type system (migration 011) was superseded by the v2 rich-typing
spine. Mapping for the rooms (confirm in Open Q):
- **Skills room** → `voice`, `template`, `method` (≈ the craft layer; 20 items)
- **Library/Knowledge room** → the claim/source types (`principle`, `position`,
  `idea`, `knowledge`, `resource`, …)
- **Concepts room** → `concept_pages` (9: 6 knowledge-flavour, 3 skills-flavour)

## D. Reuse plan (extend, don't rebuild)

- **Reuse as-is:** `/api/profile`, `/api/profile/hypergraph`, `/api/library/stats`,
  `/api/library/concepts`, `/api/library/items`, `/api/workspaces`,
  `/api/auth/session`; cream token block + header lockup; Fraunces + mono fonts.
- **Build new (page only):** `public/home-next.html` (the page), and a vanilla
  `MindGraphHero` module inside it (SVG + rAF, reduced-motion aware, sampled to
  24–40 nodes, domain→brand colour).
- **Build new (backend — the only additions, both additive read-only, tenant-scoped,
  no schema/migration):**
  1. `GET /api/profile/serendipity` → most recent high-confidence ELABORATION as
     `{ from:{id,title}, to:{id,title}, at }` or `null`.
  2. `GET /api/twin/review-presence` → `{ pending: boolean }` (presence only — the
     brief forbids surfacing a count).
- **Will NOT build:** any parallel design system, any second graph model, any
  change to the existing home/nav/schema/writes, any DB migration.

## E. Risk notes

1. **Cream-on-`/twin` visual divergence** (biggest): a cream page under `/twin`
   will not match the dark `/twin/profile`/`/twin/library` pages. Native to Luto's
   onboarding surface, but inconsistent within `/twin`. Needs your call.
2. **Graph palette:** existing domain colours are dark-bg tuned; expect to add a
   cream-surface colour remap (additive, in the new page only).
3. **Two new endpoints** are required for serendipity + whisper. They are additive
   and read-only, but they ARE new backend files — flagging because the brief says
   "no backend changes." Reading-only new endpoints don't alter existing routes,
   schema, or writes; if you'd rather have ZERO new endpoints, both elements can
   instead **hide entirely** in v1 (serendipity + whisper omitted) and ship later.
4. **No separate `/voice` or `/ask` routes:** voice/chat/capture are all surfaces
   *inside* `/twin` (JS surface-switching). Room tiles for Voice/Ask would link to
   `/twin`; opening a specific surface may need a query param `/twin` doesn't yet
   read (confirm, or just land on `/twin`).
5. **Capture bar:** inline ingest would hit `/api/twin/turn` (a write path the brief
   says to avoid touching). Recommend the bar **routes to `/twin`** (the existing
   capture surface) in v1 rather than ingesting inline.
6. **Shared count source ambiguity:** `/api/workspaces` vs `/api/library/shared.js`
   — confirm which returns the "shared with you · N" number before wiring.

---

## Answers / recommendations to the brief's Open Questions

1. **Route name / gating:** `/twin/home-next` via one additive rewrite, **not in
   nav, no feature flag** — reachable by URL only (simplest; the page already
   `noindex`s). Promote later by adding a nav link. ✅ recommend.
2. **Demo tenant:** rich variant → Piotr's tenant `21733441` (69 items/9 concepts).
   Cold-start → a throwaway low-data tenant I spin up for the demo.
3. **Skills vs Knowledge types:** Skills = `voice` + `template` + `method`;
   Library = `principle`/`position`/`idea`/`knowledge`/`resource`. **Confirm
   whether `method` belongs to Skills or Library** (it's the ambiguous one).
4. **Serendipity source:** recent high-confidence ELABORATION from
   `reconciliation_decisions` (69 available). Fallback if none → hide the line. ✅
   Needs the new read endpoint (D.1). Note: current ELABORATIONs are shadow-mode
   decisions — they still name a real connection, so they're valid to surface.
5. **Cold-start threshold:** `< 5` items (brief's suggestion). ✅
6. **Capture bar:** route to the existing `/twin` capture surface in v1 (no inline
   write). ✅

## Two questions only you can answer before Phase 1

- **Palette:** cream onboarding surface (recommended) or dark `/twin` app shell?
- **Serendipity + whisper:** OK to add the two additive read-only endpoints (D.1,
  D.2), or hide both elements in v1 to keep zero new backend?

Everything else is ready. On sign-off I'll start Phase 1 (route + cream shell +
greeting + rooms grid, real data, static — no graph yet), one PR, additive, not in
nav.
