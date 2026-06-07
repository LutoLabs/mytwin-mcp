# Canon seed (Eleusis)

These files are the body text of the canon items the twin holds **about itself** —
its operational self-knowledge and its worldview. They are the third canon layer,
sitting alongside the Soul File (spirit, origin, who it is for) and the
conversation-first system prompt (behaviour); they describe *what the twin is,
what it can do, and what it believes* — they do not restate the other two.

The seed is stored **once**, under a dedicated system tenant, and merged into
**every** tenant's retrieval from the shared `canon` Pinecone namespace. It is
attributed to **Eleusis**, never to the user, and walled off from the machinery
that learns the user's own thinking. See:

- `lib/canon.js` — constants, item definitions, content reader
- `schema/migrations/027-canon-provenance.sql` — `canon` provenance value + system tenant/user
- `scripts/load-canon.mjs` — the re-runnable loader

| File | Canon item |
|---|---|
| `self-knowledge.md` | What the twin is and what it can do (`CANON_ITEMS[0]`) |
| `worldview.md` | The worldview and thesis (`CANON_ITEMS[1]`) |

## ⚠ These are FIRST-DRAFT placeholders

The official seed prose (`twin-seed-file.md`) was not available when the mechanism
was built. The current text is accurate and safe to ship, but it is **product
voice that should be owned and refined** before launch. Replace the bodies, then
reload — no schema or code change required.

## Updating the seed

Edit a file, then (after migration 027 has been applied once):

```bash
node --import ./scripts/_loadenv.mjs scripts/load-canon.mjs            # load / update
node --import ./scripts/_loadenv.mjs scripts/load-canon.mjs --dry-run  # preview only
```

The loader upserts the same rows and vectors (stable ids), so every account
receives the update on its next session — no per-account backfill.
