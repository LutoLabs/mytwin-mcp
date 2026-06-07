# Step 0 — Gap Report: Activation Moment v2 ("the coalesce")

Audit only. No code. Stop for sign-off before Phase 1.
All findings verified against the live code in `public/profile.html` + `api/`.

## CRITICAL FINDING — the profile renderer CAN be state-driven (reuse is feasible)

The profile graph (`/twin/profile`) is a **hand-rolled three.js r128 scene** (CDN, not a
force-graph library), defined inline in `public/profile.html` as `renderHypergraph(graph)`
(≈ lines 625–990). Its architecture is exactly what v2 needs:

- **Per-node handles already exist.** Each node is stored in a `nodes[]` array as
  `{ it, body:Mesh, halo:Sprite, mat:MeshStandardMaterial, base:Vector3, baseEmissive,
  baseSize, baseHalo, glow }` (line ~730). Placeholders live in a parallel `phNodes[]`
  with `{ body, shell(wireframe), halo, mat, base, glow }` (line ~835). So **position
  (`base`/`body.position`), material (opacity/emissive/color), and scale are all
  externally addressable per node** — the decisive question for reuse.
- **A per-frame animate loop already interpolates per-node values.** `(function animate(){
  requestAnimationFrame(animate); … })` (line ~967) ramps `autoYaw` rotation and, per node,
  lerps a `glow` value (`n.glow += (tg-n.glow)*0.2`) then mutates `body.scale`,
  `mat.emissive`, `halo.opacity/scale`. This is the exact hook to add per-node
  `targetPos / formProgress / realness` and interpolate them with the §4 easings.
- **Real-vs-ghost is already a thing.** Real nodes = glossy `MeshStandardMaterial` spheres
  + additive halos (line ~718). Placeholders = low-opacity (0.4) body + translucent
  **wireframe shell** + dim halo (line ~819). v2's "solid/bright vs translucent/unformed"
  contrast is native to the renderer.
- **Hover-to-see-your-text exists.** Raycaster + tooltip renders `n.it.title` via
  `textContent` (line ~917–928) — principle #7 (inspectable, no injection) is already met.
- **Look/spec to reuse verbatim:** `SPREAD=50, JITTER_MULT=23, GAP=2.0, ITER=120`; FogExp2
  `0x05060e`; PerspectiveCamera fov 58; ambient `0x404a66` + key directional + cool fill;
  golden-ratio domain anchors; 600-point starfield; pixelRatio capped at 2.

**Conclusion:** No dedicated renderer needed. v2 = the SAME scene/materials/lighting/layout,
driven from a scattered ghost start through ARRIVAL→UNDERSTANDING→COALESCE→SETTLED via the
existing animate loop. The look is identical because it is literally the same code.

**One caveat (structure):** the renderer is **inline in profile.html, not a shared module.**
So "reuse" is a choice between two paths — see Reuse plan / Open Q1.

## A. The profile graph renderer (the reuse target)
- File: `public/profile.html`, `renderHypergraph()` (625–990); three.js r128 CDN (line 455).
- Library: custom WebGL via three.js (NOT 3d-force-graph). Nodes = sphere meshes + sprite
  halos; edges = thin `CylinderGeometry` meshes oriented between node bases (line ~770).
- Camera: perspective, drag-orbit + wheel-zoom + slow `autoYaw` auto-rotation; fog for depth.
- Drivable over time: **YES** — positions via `node.base`/`body.position`, materials via
  `node.mat` (opacity/emissive/color), scale via `body.scale`, all already mutated per frame.

## B. Ingest + classify path (the "understanding" beat) — the main GAP
- **Ingest** (typed): `tools/storage.js → addKnowledge(ctx,{type,title,content,tags,…})`;
  the chat/capture turn is `api/twin/turn.js`; documents `api/twin/document.js`. All write.
- **Intent classifier:** `api/twin/classify-intent.js` returns `{ intent:'chat'|'store'|
  'ambiguous', confidence, proposal:{title,tags,provenance} }` — and explicitly states
  *"type is NOT your job"* (line 59). So it gives intent + tags, **not a category**.
- **Reconciliation classifier:** `lib/reconciliation/classifier.js` classifies the
  RELATIONSHIP between a fragment and an existing item (DUPLICATE/ELABORATION/…), **not the
  category of a single new thought.** Returns confidence, but for the wrong question.
- **GAP:** nothing today maps a thought → one of v2's 7 placeholder categories (skills,
  meeting notes, preferences, writing style, brand spec, LinkedIn voice, email voice) with a
  confidence. That mapping is the heart of the AHA beat.
- **Reuse available for the fix:** `lib/anthropic.js → callFastJson({system,messages,schema})`
  (Haiku, strict-JSON) is the exact tool to add a thin **category classifier**: enum of the 7
  categories + `confidence`, with a **confidence gate** (name a category only above a high
  bar; else return null → "finding where this belongs…"). Honors principle #4 cleanly. This
  is additive (prototype-only) and read-only (classify without storing).

## C. Branding tokens (dark, from profile.html)
- Palette: `--bg #05060e`, panel `rgba(9,11,24,0.92)`, line `rgba(150,160,220,0.18)`,
  ink `#eef0ff`, dim `#666e9a`/`#8088bb`, brand `--yellow #FFD400`, red `#ff5d7a`.
- Display serif **Fraunces**; mono labels **Spline Sans Mono** (both already loaded).
- Logo lockup: `.logo-mark` gold square + "MyAITwin / BY LUTO" (reusable markup).
- Graph cluster colours: `DOMAIN_COLOR` 6-hue map (yellow `FFD400`, teal `00E0C6`, pink
  `FF3D8B`, blue `5B8CFF`, orange `FF7A1A`, purple `A85CFF`) — reuse these hues, mapped to
  the 7 v2 categories.

## D. Reduced-motion / perf conventions
- **Reduced-motion:** only `public/home-next.html` honours `prefers-reduced-motion` (the
  page I built earlier). The **profile renderer does NOT** (auto-rotates regardless). So v2's
  reduced-motion path (§7: cross-fade, no coalesce spectacle) is a **net-new addition** —
  I'll model it on the home-next pattern.
- **Perf:** renderer caps `pixelRatio` at 2; the O(n²) separation relax runs **once at build**
  (not per frame); per-frame cost is small. v2's coalesce touches ≤ ~14 nodes (7 ghosts +
  seed + a few), so 60fps is comfortable. Budget item: stagger material swaps, pre-warm the
  halo texture (already a shared `CanvasTexture`).

## Reuse plan (extend, don't rebuild)
- **Reuse verbatim:** the entire scene/material/lighting/layout/animate code, the halo
  texture, the starfield, the hover tooltip, branding tokens, `callFastJson`.
- **Build new (prototype only):** the state machine (`IDLE_UNFORMED → ARRIVAL →
  UNDERSTANDING → COALESCE → SETTLED_LIVING`, + `JOIN`, `SYNC`), the idle ghost field with
  the 7 cue labels, the choreography/timeline module (§4 timings in one place), the thin
  category classifier (or stub), the reduced-motion path, and the route page.
- **Will NOT do:** rebuild a flat/2D graph (v1's mistake), change the profile page, touch
  schema, or write on the prototype path unless explicitly gated.

## Risks
1. **Renderer is inline, not modular** (biggest). Two ways to honour "reuse the real
   renderer" — see Open Q1.
2. **No category classifier exists** — the AHA depends on a new (thin) one or a right-or-silent
   stub. Either is additive; pick per Open Q2.
3. **Reduced-motion is net-new** for the graph — must be built, not inherited.
4. **v1 ≠ v2.** The earlier standalone `activation-moment.html` (3d-force-graph, single file)
   is a different artifact; v2 is in-app and reuses the profile renderer. Not an extension of v1.

## Answers / recommendations to the brief's Open Questions
1. **Reuse vs dedicated renderer** → Reuse the profile renderer. Since it's inline, I
   recommend **porting the exact render code into the prototype page** (`/twin/activation-next`)
   and layering the state machine — additive, zero risk to the live profile page, identical
   look (same code). A later refactor can extract a shared module if you want long-term reuse.
   (Alternative: extract a shared module now — cleaner reuse, but refactors the frozen-spec
   profile renderer. Your call.)
2. **Classifier** → a thin **dedicated category classifier** via `callFastJson` (7-category
   enum + confidence, confidence-gated to "right or silent"). Falls back to a keyword stub if
   you'd rather ship zero LLM calls in the prototype. Recommend the real thin classifier — the
   AHA is the whole point.
3. **Sound** → build the hooks, ship **muted** (your recommendation). Low stakes.
4. **Route/gating** → `/twin/activation-next`, additive rewrite, not in nav, URL-only.
5. **Input scope** → **type-only** for Phases 1–2 (nail the moment), add drag-drop ingest in a
   later phase. (Open to including drop now if you want it in the core.)
6. **Categories** → use the brief's 7 (skills · meeting notes · preferences · writing style ·
   brand spec · LinkedIn voice · email voice), each mapped to a `DOMAIN_COLOR` hue. Confirm/edit.

## Decisions that gate Phase 1
- **Reuse approach:** port-the-renderer-into-the-prototype (recommended) vs extract-shared-module.
- **Understanding beat:** thin real category classifier vs right-or-silent keyword stub.
- **Input scope:** type-only first vs include drag-drop now.
Everything else has a sensible default above. On sign-off I'll start Phase 1 (the
IDLE_UNFORMED ghost field — get it beautiful before the coalesce).
