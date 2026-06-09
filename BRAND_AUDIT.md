# Brand audit — rename checklist

The product name is mid-migration. This sweep did **not** rename anything: the
current value stays `MyAITwin` / `by Luto`. This document is the complete map of
every user-visible or identifying brand string, split into what a rename can now
change in one place versus what must be edited by hand.

**App architecture note:** this is a static-HTML app (pages in `public/*.html`)
served by Vercel, not a server-rendered framework. There is no build step that
can template `<title>`/`<meta>` tags, so those cannot be driven by a runtime
constant. They are listed below as manual targets. The visible app chrome (the
header lockup) *is* driven by a constant.

---

## 1. Centralised now — change these two files to rename the runtime surfaces

| File | Exports | Drives |
|------|---------|--------|
| `lib/brand.js` | `BRAND_NAME`, `BRAND_BYLINE`, `BRAND_FULL`, `BRAND_TITLE_SUFFIX`, `APP_URL`, `APP_HOST` | Share / invite emails (`lib/sharing.js`), workspace emails (`lib/workspaces.js`) |
| `public/brand.js` | `window.BRAND` (`NAME`, `BYLINE`, `FULL`, `TITLE_SUFFIX`, `apply()`) | The header logo lockup (`.logo-name` / `.logo-by`) on every authenticated page: twin, library, voice, connections, profile, home |

To rename: set `BRAND_NAME` / `BRAND_BYLINE` in **both** files (keep them in
sync) and redeploy. Everything in this section updates automatically.

---

## 2. NOT centralisable — manual rename targets

These are static markup, infra identifiers, or external registrations. A
runtime constant cannot reach them. Edit each at rename time.

### 2a. Static page titles (`<title>`) — one per page
`public/twin.html:6`, `library.html:6`, `voice.html:6`, `connections.html:6`,
`profile.html:6`, `home.html:6`, `account.html:6`, `concept.html:6`,
`404.html:6`, `index.html:6`, `docs.html:6`, `create.html:6`, `invite.html:6`,
`privacy.html:140`*, `security.html:140`*, `terms.html:140`*, plus the
prototype/landing variants `home-next.html:6`, `activation.html:7`,
`activation-v3.html:6`, `activation-next.html:6`.
(* privacy/security/terms titles are at line 6; the line 140 entry is the
canonical link — see 2c.)

Suffix convention: `· MyAITwin` for app pages, `· MyAITwin MCP` for the
marketing/docs pages (`index`, `docs`, `privacy`, `security`, `terms`,
`create`).

### 2b. Meta tags (`<meta name="description">`, `og:title`, `og:description`)
Present in: `index.html`, `twin.html`, `voice.html`, `connections.html`,
`docs.html`, `invite.html`, `privacy.html`, `security.html`, `terms.html`.

### 2c. Canonical URLs (domain)
`docs.html:226`, `security.html:140`, `index.html:512`, `privacy.html:140`,
`terms.html:140` — all `https://myaitwin.lutolearn.com/...`.

### 2d. Schema.org JSON-LD
`index.html:518-519` — `SoftwareApplication` with `@id`
`https://myaitwin.lutolearn.com/#software` and name `MyAITwin MCP`.

### 2e. Auth / OAuth emails (inline brand, not yet centralised)
These define their own email HTML with `MyAITwin` / `by Luto` inline. They were
left untouched in this sweep to keep the change low-risk; centralise them into
`lib/brand.js` (same pattern as `lib/sharing.js`) or edit inline at rename:
`api/auth/signin.js`, `api/auth/request.js`, `api/auth/verify.js`,
`api/auth/claim.js`, `api/oauth/authorize.js`, `api/oauth/callback.js`.

### 2f. Model identity in system prompts
The model refers to itself as "MyAITwin" in:
`api/twin/turn.js` (`chatInstruction`), `api/twin/chat.js`,
`api/twin/document-propose.js`. The main system prompt is loaded from the
`MYAITWIN_SYSTEM_PROMPT` env var (see `lib/system-prompt.js`) — rename there too.
This is tightly coupled to the twin's self-knowledge ("Eleusis" canon); confirm
the identity decision before editing.

### 2g. Infra identifiers (changing these is a coordinated, breaking change)
- **MCP server name:** `lib/create-server.js:92` (`name: 'myaitwin'`). Changing
  this changes how the server identifies to MCP clients and registries.
- **Inngest client id:** `lib/inngest.js:6` (`id: 'myaitwin'`). Changing this
  forks the function namespace — coordinate with Inngest.
- **Domain / APP_URL fallback:** `myaitwin.lutolearn.com` is the runtime origin.
  The live value comes from `process.env.APP_URL` (single source); the hardcoded
  fallback appears in `lib/brand.js` and 9 other files
  (`api/oauth/*.js`, `api/auth/*.js`, `api/well-known/*.js`, `api/invites/redeem.js`).
  At rename: update the env var first, then the fallbacks.
- **OAuth client/registry names, app-store / connector listings:** external to
  this repo. Rename in the respective dashboards.

### 2h. Not present (note for launch)
- No web app manifest (`manifest.json` / `site.webmanifest`) exists. If a PWA
  manifest is added before launch, its `name` / `short_name` belong in this
  checklist.

---

## Acceptance note

The original brief's acceptance check (`grep -ri "myaitwin" --include="*.tsx"`
returns only the constant file) assumes a server-rendered framework. This app is
static HTML, so the visible **app chrome** is constant-driven (section 1) and
everything inherently per-file is enumerated above (section 2) as the rename
checklist. That is the achievable equivalent for this architecture.
