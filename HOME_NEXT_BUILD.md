# home-next — build complete (preview page)

Throwaway handoff (do not commit). The calm "complete home" preview is built and
verified end-to-end against the live tenant. Additive only; nothing deployed.

## What shipped (all phases)

- **Route** `/twin/home-next` — new `public/home-next.html` + ONE additive
  `vercel.json` rewrite line. Not in nav, `noindex`, URL-only. Existing home/nav
  untouched, still the default.
- **Dual theme** — light = Luto cream onboarding tokens; dark = the hypergraph app
  theme. `prefers-color-scheme` + a header toggle (persisted). Hero recolours live.
- **Greeting + abundance sub-line** — time-aware, firstName from `/api/profile`
  owner.name; "{items} thoughts · {concepts} living ideas · quietly growing".
- **Animated hero** (`MindGraphHero`, vanilla SVG + rAF) — reuses
  `/api/profile/hypergraph`; samples 32 of N nodes balanced across the 6 domains;
  clustered constellation, drift + breathing halos, one amber serendipity pulse;
  `prefers-reduced-motion` → static. Greeting sits above the band (no overlap).
- **Capture bar** — routes to the existing `/twin` capture surface (no inline write).
- **Serendipity line** — the one gift; names a real recent high-confidence
  ELABORATION; drives the hero pulse; hides if none.
- **Whisper** — presence-only (never a count); shows only when review_items pending.
- **Rooms grid** — Concepts / Library / Skills / Ask / Voice / Shared, real counts,
  abundance-framed. "Shared with you" hides at 0. Skills = voice+template+method.
- **Cold-start** (< 5 items) — ghost hero (faint hollow nodes in labelled clusters:
  ideas/voice/decisions/taste/people), invitation room copy, Voice as the warm
  on-ramp, wake-up greeting + capture hint; no serendipity, no whisper.
- **Responsive** — rooms stack < 760px; no horizontal overflow at 375px.

## New files (additive)

- `public/home-next.html` — the page (self-contained, like the other pages)
- `api/twin/serendipity.js` — GET, runTwin tenant-scoped, read-only. Most recent
  high-confidence ELABORATION as `{from,to,confidence,at}` or null.
- `api/twin/review-presence.js` — GET, runTwin tenant-scoped, read-only. `{pending:boolean}`.
- one line in `vercel.json` rewrites (no `functions` change → 50-cap untouched).

Neither endpoint is in the `functions` block (default maxDuration is fine).

## Verified

- Rich tenant (team@lutolearn.com, 69 items): greeting 69/9, rooms 9/69/20, hero
  32 nodes + edges, serendipity line ("On education…" ↔ "Region: Education…",
  conf 0.92), whisper hidden (0 pending). Both themes. No console errors.
- Cold-start (throwaway 0-item user, since torn down): ghost hero + invitation
  rooms + warm Voice + wake-up copy. Serendipity/whisper/Shared hidden.
- Mobile 375px: single-column rooms, no overflow.
- Footprint: `git status` shows only the new files + the single vercel.json rewrite;
  twin/profile/library/account/concept .html all untouched.

## Decisions made during the build (the two you delegated)

- **Serendipity + whisper:** built the two additive read-only endpoints (the page's
  soul). Consistent with "additive, reads only" — no schema, no writes, no change to
  existing routes.
- **`method` → Skills** (voice+template+method = 20). The brief names method as a
  skills-layer example and a method is "a way you turn thinking into output".

## Notes / smaller calls

- "See the thread" links to `/twin/library` (there is no per-knowledge-item detail
  route; concepts have one, generic items don't). Refine if an item route appears.
- Voice/Ask room tiles link to `/twin` (those are surfaces inside /twin, not routes).
- No "Connect" cold-start tile — no real connector source was found; omitted rather
  than faked (per the brief's "real or absent" rule).
- Hero domain colours come from the existing dark-tuned `0x` palette; on cream they
  are deepened ~30% toward ink for contrast (light only).

## To view / promote

- Local: `vercel dev`, sign in, open `/twin/home-next`.
- Nothing committed, no deploy. Promote later by committing the additive files and
  (only when you choose) adding a nav link. HEAD was moved by another session, not
  by this work.
