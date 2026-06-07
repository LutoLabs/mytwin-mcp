# Profile v1 — handoff brief for incorporation + deploy

This is a throwaway handoff doc. Do not commit it. It tells you what the
Profile v1 build is, which uncommitted files belong to it, what is already
live, and how to ship it safely alongside your own in-flight work.

## What this build is

`/twin/profile` — a new profile page that replaces `/twin/account`. Centerpiece
is a permission-scoped three.js hypergraph of the owner's knowledge items.
The graph returns ONLY items the requester has Can Use+ on, with edges drawn
only between accessible nodes (induced subgraph). It fails CLOSED.

Verified end-to-end through the real route: 6-node graph renders with edges,
stats read items / concept pages, Settings section present (signout,
shared-token, delete-account all wired to existing APIs), nav correct, zero
console errors. `/twin/account` → 307 → `/twin/profile`.

## Already applied to PRODUCTION (do not re-run)

- Migration `schema/migrations/020-profile-placeholder-dismissals.sql` is LIVE
  on prod (project ref `eqacaypuutlqkncpjqbl`). Additive-only: creates
  `profile_placeholder_dismissals`, one index, RLS enabled. No data destruction.
  PostgREST schema cache was reloaded. Nothing else to do DB-side.

## Files that belong to Profile v1 (the ONLY files to stage for this build)

New:
- `api/profile/placeholder-fill.js`
- `api/profile/placeholder-dismiss.js`
- `api/profile/hypergraph.js`  (modified — already existed)
- `schema/migrations/020-profile-placeholder-dismissals.sql`

Modified:
- `lib/profile.js`
- `public/profile.html`
- `public/twin.html`   (one link: "Account settings" → "Profile", href /twin/account → /twin/profile)
- `vercel.json`        (see caveat below)

Safe stage command (stage exactly these, nothing else):

    git add api/profile/hypergraph.js api/profile/placeholder-fill.js \
            api/profile/placeholder-dismiss.js lib/profile.js \
            public/profile.html public/twin.html vercel.json \
            schema/migrations/020-profile-placeholder-dismissals.sql

## NOT part of this build — leave as-is

These are your changes; Profile never touched them:
- `api/workspaces/[id]/index.js`
- `lib/workspaces.js`
- `public/account.html`
- `api/workspaces/[id]/invitations/`

## vercel.json — read before you touch it

The `functions` block has a HARD 50-property limit; Vercel rejects 51+.
Profile added exactly ONE entry: `"api/profile/placeholder-fill.js": { "maxDuration": 60 }`
(the only profile route that needs >default, since it calls addKnowledge).
`hypergraph`, `placeholder-dismiss`, and `index` intentionally have NO entries
to stay under the limit. If you add your own function entries, count carefully —
if the total would exceed 50, you must drop or merge entries, not just append.

Profile also changed in vercel.json:
- rewrite: `/twin/profile` → `/profile.html` (was `/twin/account` → `/account.html`)
- redirect added: `/twin/account` → `/twin/profile` (permanent: false / 307)

If you have your own rewrites/redirects in flight, these three lines are the
only Profile-owned ones; merge rather than overwrite.

## Frozen — do not change without sign-off from Piotr

- Render spec: SPREAD, JITTER_MULT, GAP, ITER, lighting, halo/edge params,
  animation rates. The look is approved as-is.
- Permission scoping is non-negotiable: no "redacted" markers, induced-subgraph
  only, fail-closed. Don't relax the 401/403 logic in api/profile/hypergraph.js.
- Tooltip titles are escaped via textContent (user-data XSS guard) — keep it.

## Deploy steps

1. Confirm working tree: the eight Profile files above are present/modified.
2. Stage exactly those eight (command above). Do NOT `git add -A`.
3. Commit (no em dashes in the message — house rule).
4. Migration 020 is ALREADY on prod, so deploy is code-only. Push / let Vercel
   build. No DB step at deploy time.
5. Post-deploy smoke check on prod:
   - GET /twin/profile → 200, hypergraph renders, stats populate.
   - GET /twin/account → 307 → /twin/profile.
   - A user with no Can Use grants on another's items must NOT see those nodes.

## State note

HEAD moved to `621d820` during the session (not by the Profile work — that
session made zero commits). Verify HEAD is where you expect before committing.
