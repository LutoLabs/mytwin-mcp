# Step 0 — Gap Report: Activation Moment v3 ("premium coalesce")

Audit only. No code. Stop for sign-off before Phase 1.
Supersedes v2. Quality bar = the live profile hypergraph (`public/profile.html`).
Builds on the v2 audit (`ACTIVATION_V2_GAP_REPORT.md`); this focuses on the v3-decisive
findings: the EXACT gloss/density recipe, and where v0.7 fell short.

## CRITICAL FINDING — reuse is feasible, and here is the exact recipe to replicate

The profile graph is a custom three.js r128 scene in `public/profile.html`
(`renderHypergraph()`, ~625–990). It is drivable over time (per-node `body`/`halo`/`mat`/
`base` refs + a per-frame animate loop, verified in the v2 audit). For v3, the bar is
visual indistinguishability, so the decisive deliverable is replicating its **exact**
material/lighting/density/palette. From the live code:

- **Gloss recipe (the thing v0.7 missed):**
  - Sphere body: `MeshStandardMaterial({ color, emissive: color.clone().multiplyScalar(0.35),
    roughness: 0.45, metalness: 0.1 })`, `SphereGeometry(size, 32, 32)` (line ~718–721).
  - Size by connectivity: `size = 2.2 + (degree / maxDegree) * 2.6` (line ~717) — **vary size
    within a cluster** (bigger = more-connected). v0.7 used uniform ~3.0 spheres → flat read.
  - Soft halo: additive `SpriteMaterial` (`haloTex` radial gradient), `opacity 0.4`, scale
    `size * 3.2` (line ~722–727).
  - **Lighting = the specular highlight:** `AmbientLight(0x404a66, 1.1)` + key
    `DirectionalLight(0xffffff, 1.4)` at `(1, 1.2, 1)` + cool fill
    `DirectionalLight(0x88aaff, 0.5)` at `(-1,-0.5,-0.5)` (line ~675–677). This key light is
    what makes the crisp upper highlight + shaded underside. Reuse verbatim.
  - Depth: `FogExp2(0x05060e, 0.005)` (line ~667); `PerspectiveCamera(58, …, 0.1, 4000)` at
    `z=150` (line ~668). Front = larger/brighter, back = fogged.
- **Density recipe (the other thing v0.7 missed):** the profile graph packs **dozens** of
  nodes — domain anchors on a golden-ratio sphere `× SPREAD(50)`, per-node hash jitter
  `× 23`, then **O(n²) separation relax** (`ITER 120`, `GAP 2.0`, line ~736–759) to pack
  them tight without overlap. v0.7 rendered only **13 nodes total** → "a sketch," not "a
  full mind." v3 must synthesise a dense structure (~6 lobes × ~10–14 nodes ≈ 70–90), sized
  by pseudo-degree, packed with this exact relax.
- **Edge-web:** thin `CylinderGeometry` links, `opacity 0.22 + strength*0.25`,
  `r 0.08 + strength*0.10`, top-2 shared-tag siblings per node (line ~762–784) — a faint,
  dense connective mesh. v0.7's 16 fat-ish lines read as a diagram, not tissue.
- **Palette (reuse EXACTLY — the jewel chroma):** `DOMAIN_COLOR` (line ~31–38):
  `0xFFD400` gold · `0x00E0C6` cyan · `0xFF3D8B` magenta · `0x5B8CFF` periwinkle ·
  `0xFF7A1A` orange · `0xA85CFF` violet. Exactly the cyan/gold/magenta/orange/violet/
  periwinkle the brief §1 lists.

**Conclusion:** No separate renderer. v3 = **port the profile renderer's exact
material/lighting/layout/relax/edge code** into the prototype, generate a dense synthetic
structure with it (so the *formed* state is indistinguishable from profile), then drive it
through the animation states. This is a stronger reuse than v0.7, which hand-rolled a
simplified look.

## What v0.7 (`activation-next.html`) got wrong (so v3 fixes the right things)
1. **Too sparse** — 13 nodes vs profile's dozens. → densify to ~70–90, sized by degree.
2. **Flat-ish material** — own params + uniform size. → use the exact profile gloss recipe + size-by-degree.
3. **Thin reuse** — replicated the *idea*, not the profile code. → port the real material/lighting/relax/edges.
4. **Floating labels over the graph** — the brief's #1 violation. v0.7 painted faint category
   labels on every ghost. → v3: **no labels over the graph at all**; one sub-caption *beneath*
   it + hover cards only.
5. **Rebuild on store #2** — v0.7 re-ran BUILD each store. → v3: first store births the
   structure; every later store skips Act 1 and only lays a brick.

## Ingest / classify path (the comprehension beat) — unchanged gap
- `api/twin/classify-intent.js` → intent + tags, explicitly "type is NOT your job".
- `lib/reconciliation/classifier.js` → relationships, not single-item category.
- **Gap:** no classifier returns one of the 7 categories + confidence. Fix (same as v2): a
  thin prototype-only classifier via `lib/anthropic.js → callFastJson` (Haiku, strict-JSON:
  7-category enum + `confidence`), confidence-gated to "right or silent" (low conf → "finding
  where this belongs…", no category named). Honors §6 / the no-wrong-label rule.

## Branding / perf / reduced-motion
- Tokens: `--bg #05060e`, `--yellow #FFD400`, Fraunces (serif display), Spline Sans Mono (mono).
- Perf: profile caps `pixelRatio` at 2 and runs the O(n²) relax **once** (not per frame). At
  ~80 nodes + halos + a faint edge-web that's comfortably 60fps; sample/cap if needed.
- Reduced-motion: only `home-next.html` honors it today; the profile renderer doesn't. v3's
  reduced-motion path (cross-fade to formed, block already locked) is net-new (model on home-next).

## Answers to the open questions
1. **Renderer** → reuse: **port the profile renderer's exact material/lighting/relax/edge
   code** into `activation-v3.html`; formed state must be indistinguishable from profile. (Not
   a separate renderer.)
2. **Classifier** → thin real classifier via `callFastJson`, confidence-gated. (Carried from v2.)
3. **Palette** → reuse `DOMAIN_COLOR` exactly. ✓ assumed yes.
4. **Sound** → build the hooks, ship **muted** (default). Low stakes.
5. **Route** → `/twin/activation-v3`, additive rewrite, not in nav.

## Decision that gates Phase 1
- Confirm: **port-the-profile-renderer-exactly** (recommended) — I build `activation-v3.html`
  fresh (leaving v0.7 as a record), and **Phase 1's gate is the STATIC formed graph looking
  as good as the profile page** before any animation (per §8 "ship 1 before 2").
- Everything else has a default above (thin classifier, palette reuse, sound built+muted).

On sign-off I'll start Phase 1: the profile-grade dense formed structure + idle ghost field +
input, and we judge the static render against `/twin/profile` before touching animation.
