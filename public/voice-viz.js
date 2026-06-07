// voice-viz.js
// Shared audio engine + pluggable renderers for the Voice visualiser.
//
// Architecture (per the Stage-3 brief): one audio engine reads the existing
// capture stream and emits smoothed, banded { level, bass, mid, treble }; a
// renderer is a swappable skin on top. The hard part — making motion feel
// premium rather than "Winamp" — lives in the engine, so personalities A/B
// without rewriting it.
//
//   AudioEngine ──read()──► { level, bass, mid, treble }  (0..1.4, smoothed)
//        │                                                 │
//        └─ wraps the studio's AnalyserNode (no 2nd mic)   └─► Renderer.frame()
//
// Renderers: Constellation (LEAD — reads as the Brain hypergraph), Cloud and
// Blob (fallbacks behind ?viz=). Each implements init(ctx,w,h) / resize(w,h) /
// frame(audio,t) and draws to a transparent 2D canvas over the paper stage.
//
// Palette (locked design system): paper #FBFAF7, ink #0F0E0D, accent #FFE34A,
// muted amber rgba(214,160,40,…) for depth/back layer.

const YELLOW = [255, 227, 74];
const AMBER  = [214, 160, 40];
const INK    = [15, 14, 13];

// Pre-baked soft-dot sprite: a radial-alpha disc drawn once and scaled with
// drawImage — cheap soft glow at 150 particles (vs a per-particle gradient).
function softSprite([r, g, b], peak = 0.95) {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  const grad = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0,    `rgba(${r},${g},${b},${peak})`);
  grad.addColorStop(0.45, `rgba(${r},${g},${b},${peak * 0.5})`);
  grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
  x.fillStyle = grad;
  x.beginPath(); x.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); x.fill();
  return c;
}

// ── Audio engine ─────────────────────────────────────────────────────────────
// Reads the studio's AnalyserNode and turns it into smoothed, banded signals.
// Four non-negotiables from the brief: banded mapping (bass≠mid≠treble), easing
// (no raw analyser value reaches a renderer), an idle floor (silence breathes),
// and a single clamped sensitivity multiplier.
export class AudioEngine {
  constructor({ sensitivity = 0.8, reduceMotion = false } = {}) {
    this.sensitivity  = sensitivity;
    this.reduceMotion = reduceMotion;
    this.analyser = null;       // set via attach(); null → idle floor only
    this._freq = null;
    this._time = null;
    this.level = 0; this.bass = 0; this.mid = 0; this.treble = 0;
    // Raw-signal flags for the studio's "mic on but silent" detection.
    this.sampled = false;
    this.sawSignal = false;
  }

  // Wrap the capture analyser. Caller creates it on the existing stream with
  // fftSize 1024 / smoothingTimeConstant 0.8.
  attach(analyser) {
    this.analyser = analyser || null;
    this.sampled = false;
    this.sawSignal = false;
    if (this.analyser) {
      this._freq = new Uint8Array(this.analyser.frequencyBinCount);
      this._time = new Uint8Array(this.analyser.fftSize);
    }
  }
  detach() { this.analyser = null; }

  read(t) {
    // Idle floor — a slow breath so the visualiser is never frozen, even at
    // silence (mid-recording pauses included).
    const idle = 0.04 + 0.025 * (0.5 + 0.5 * Math.sin(t * 0.0012));

    let tl = idle, tb = idle * 0.8, tm = idle * 0.6, tr = idle * 0.5;
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this._freq);
      this.analyser.getByteTimeDomainData(this._time);

      let sum = 0;
      for (let i = 0; i < this._time.length; i++) {
        const v = (this._time[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this._time.length);
      this.sampled = true;
      if (rms > 0.015) this.sawSignal = true;

      const f = this._freq, N = f.length;
      const band = (a, b) => { let s = 0, c = 0; for (let i = a; i < b && i < N; i++) { s += f[i]; c++; } return c ? s / (c * 255) : 0; };
      const s = this.sensitivity;
      tl = Math.max(rms * 2.2 * s, idle);
      tb = Math.max(band(1, 8)   * s, idle * 0.8);
      tm = Math.max(band(8, 40)  * s, idle * 0.6);
      tr = Math.max(band(40, 128) * s, idle * 0.5);
    }

    // Headroom: loud input can punch to 1.4 before clipping flat.
    const clamp = (x) => x > 1.4 ? 1.4 : x;
    // Easing — every value lerps toward target each frame (kills jitter/strobe).
    const e = this.reduceMotion ? 0.14 : 0.22;
    this.level  += (clamp(tl) - this.level)  * e;
    this.bass   += (clamp(tb) - this.bass)   * e;
    this.mid    += (clamp(tm) - this.mid)    * e;
    this.treble += (clamp(tr) - this.treble) * e;

    return { level: this.level, bass: this.bass, mid: this.mid, treble: this.treble };
  }
}

// ── Constellation (LEAD) ─────────────────────────────────────────────────────
// Reads as the Brain hypergraph in its Standard (light) register: ink-on-paper
// nodes with yellow-ringed accents, amber depth-of-field on the back layer, a
// sparse 2-nearest-sibling web (NOT O(n²) line-spam), and a hyperedge that binds
// as the user speaks — nodes converge and links brighten on voice; loose scatter
// at silence. No beams, flashes, shockwaves, or floating labels.
class ConstellationRenderer {
  constructor({ reduceMotion = false } = {}) {
    this.reduceMotion = reduceMotion;
    this.nodes = [];
    this.edges = [];
    this.yellow = softSprite(YELLOW);
    this.amber  = softSprite(AMBER);
  }

  init(ctx, w, h) { this.ctx = ctx; this.w = w; this.h = h; this._build(); }
  resize(w, h) { this.w = w; this.h = h; }

  _build() {
    const n = this.reduceMotion ? 30 : 58;
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const z = Math.random();                     // 0 back .. 1 front (depth-of-field)
      const accent = Math.random() < 0.32;         // ~⅓ yellow accents, rest ink
      nodes.push({
        ang:   Math.random() * Math.PI * 2,
        rr:    0.30 + Math.pow(Math.random(), 0.65) * 0.78,  // scatter radius (× baseR), well spread
        r: 0, x: 0, y: 0,
        z,
        accent,
        // accent/hub nodes read larger, like the degree-sized real graph
        baseF: (0.013 + Math.random() * 0.014) * (accent ? 1.4 : 1),
        phase: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 1.1,
        drift: (Math.random() < 0.5 ? -1 : 1) * (0.00025 + Math.random() * 0.00075),
      });
    }
    nodes.sort((a, b) => a.z - b.z);               // draw back-to-front for depth
    this.nodes = nodes;

    // Seed positions so there's no first-frame pop, then compute a STABLE web:
    // each node to its 2 nearest siblings (the calm graph look, not line-spam).
    const baseR = Math.min(this.w || 300, this.h || 300) * 0.42;
    for (const nd of nodes) {
      nd.r = nd.rr * baseR;
      nd.x = (this.w || 300) / 2 + Math.cos(nd.ang) * nd.r;
      nd.y = (this.h || 300) / 2 + Math.sin(nd.ang) * nd.r;
    }
    const edges = [];
    const seen = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const near = nodes
        .map((b, j) => [j, j === i ? Infinity : (a.x - b.x) ** 2 + (a.y - b.y) ** 2])
        .sort((p, q) => p[1] - q[1])
        .slice(0, 2);
      for (const [j] of near) {
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (!seen.has(key)) { seen.add(key); edges.push([Math.min(i, j), Math.max(i, j)]); }
      }
    }
    this.edges = edges;
  }

  frame(audio, t) {
    const ctx = this.ctx;
    const w = this.w, h = this.h;
    const cx = w / 2, cy = h / 2, minDim = Math.min(w, h);
    const baseR = minDim * 0.42;
    const { level, bass } = audio;
    const rm = this.reduceMotion ? 0.5 : 1;

    // Hyperedge binding: speaking pulls the loose scatter into a bound cluster.
    const clusterAmt = Math.min(1, level * 0.55 + bass * 0.5);

    for (const n of this.nodes) {
      n.ang += n.drift * rm;
      const bob = Math.sin(t * 0.0009 * n.speed + n.phase) * 0.045;
      const targetR = baseR * (n.rr * (1 - clusterAmt * 0.40) + bob);
      n.r += (targetR - n.r) * 0.09;
      n.x = cx + Math.cos(n.ang) * n.r;
      n.y = cy + Math.sin(n.ang) * n.r;
    }

    // Links — stable web, ink, opacity rises with voice + falls with distance.
    // They tighten and brighten as the cluster binds; they never flicker in/out.
    const linkBase = 0.05 + level * 0.22;
    const fade = baseR * 1.3;
    ctx.lineWidth = 1;
    for (const [i, j] of this.edges) {
      const a = this.nodes[i], b = this.nodes[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const al = linkBase * Math.max(0, 1 - d / fade) * (0.5 + 0.5 * Math.min(a.z, b.z));
      if (al < 0.012) continue;
      ctx.strokeStyle = `rgba(15,14,13,${al.toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Nodes — back-to-front. Background = amber soft haze (depth-of-field);
    // foreground = crisp ink / yellow spheres with a gloss highlight.
    for (const n of this.nodes) {
      const rad = minDim * n.baseF * (0.5 + n.z * 0.95) * (1 + level * 0.22);

      if (n.z < 0.42) {
        ctx.globalAlpha = 0.16 + n.z * 0.5;
        const sz = rad * 4.2;
        ctx.drawImage(this.amber, n.x - sz / 2, n.y - sz / 2, sz, sz);
        ctx.globalAlpha = 1;
        continue;
      }

      if (n.accent) {                       // soft yellow halo behind accents only
        ctx.globalAlpha = 0.28 + n.z * 0.22;
        const sz = rad * 3.4;
        ctx.drawImage(this.yellow, n.x - sz / 2, n.y - sz / 2, sz, sz);
        ctx.globalAlpha = 1;
      }
      ctx.beginPath(); ctx.arc(n.x, n.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = n.accent ? '#FFE34A' : '#17150F';
      ctx.fill();
      if (n.accent) { ctx.lineWidth = Math.max(1, rad * 0.16); ctx.strokeStyle = '#0F0E0D'; ctx.stroke(); }
      // Gloss — small offset highlight reads the nodes as spheres, not discs.
      ctx.globalAlpha = n.accent ? 0.55 : 0.30;
      ctx.beginPath(); ctx.arc(n.x - rad * 0.3, n.y - rad * 0.33, rad * 0.30, 0, Math.PI * 2);
      ctx.fillStyle = n.accent ? 'rgba(255,255,255,0.85)' : 'rgba(232,222,192,0.6)';
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

// ── Cloud (fallback) ─────────────────────────────────────────────────────────
// Particles on a disc (sqrt-rand for uniform fill, random z depth). Calm ambient
// nebula: spread grows with level+bass, drift with treble, front yellow/back amber.
class CloudRenderer {
  constructor({ reduceMotion = false } = {}) {
    this.reduceMotion = reduceMotion;
    this.yellow = softSprite(YELLOW);
    this.amber  = softSprite(AMBER);
  }
  init(ctx, w, h) { this.ctx = ctx; this.w = w; this.h = h; this._build(); }
  resize(w, h) { this.w = w; this.h = h; }
  _build() {
    const n = this.reduceMotion ? 75 : 150;
    const ps = [];
    for (let i = 0; i < n; i++) {
      ps.push({
        ang:  Math.random() * Math.PI * 2,
        rr:   Math.sqrt(Math.random()),       // uniform disc fill
        z:    Math.random(),
        size: 0.6 + Math.random() * 1.2,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 1.1,
      });
    }
    ps.sort((a, b) => a.z - b.z);
    this.ps = ps;
  }
  frame(audio, t) {
    const ctx = this.ctx, w = this.w, h = this.h;
    const cx = w / 2, cy = h / 2, minDim = Math.min(w, h);
    const baseR = minDim * 0.32;
    const { level, bass, treble } = audio;
    const rm = this.reduceMotion ? 0.5 : 1;
    const spread = baseR * (0.55 + level * 1.25 + bass * 0.5);
    for (const p of this.ps) {
      p.ang += 0.0003 * rm;
      const drift = (Math.sin(t * 0.0011 * p.speed + p.phase) + Math.sin(t * 0.0007 * p.speed + p.phase * 1.7))
        * minDim * 0.02 * (0.4 + treble * 1.2) * rm;
      const r = p.rr * spread + drift;
      const x = cx + Math.cos(p.ang) * r, y = cy + Math.sin(p.ang) * r;
      const sz = minDim * 0.05 * p.size * (0.5 + p.z) * (0.8 + level * 0.5);
      ctx.globalAlpha = Math.min(0.85, 0.1 + p.z * 0.25 + level * 0.3);
      ctx.drawImage(p.z > 0.55 ? this.yellow : this.amber, x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }
}

// ── Organic blob (fallback) ──────────────────────────────────────────────────
// The shipped ring, evolved into a living non-circular contour. Two stacked
// rings (amber inner, yellow outer + thin ink stroke) + soft core. Noise uses
// integer angle multiples so the loop is seamless.
class BlobRenderer {
  constructor({ reduceMotion = false } = {}) {
    this.reduceMotion = reduceMotion;
    this.harmonics = [];
    for (let i = 0; i < 5; i++) this.harmonics.push({ k: i + 2, a: 0.5 + Math.random(), p: Math.random() * Math.PI * 2 });
  }
  init(ctx, w, h) { this.ctx = ctx; this.w = w; this.h = h; }
  resize(w, h) { this.w = w; this.h = h; }
  frame(audio, t) {
    const ctx = this.ctx, w = this.w, h = this.h;
    const cx = w / 2, cy = h / 2, minDim = Math.min(w, h);
    const baseR = minDim * 0.30;
    const { level, bass, treble } = audio;
    const rm = this.reduceMotion ? 0.4 : 1;

    const noiseAt = (ang) => {
      let s = 0, tot = 0;
      for (const o of this.harmonics) { s += o.a * Math.sin(o.k * ang + o.p + t * 0.0004 * o.k * rm); tot += o.a; }
      return tot ? s / tot : 0;
    };
    const path = (scale) => {
      ctx.beginPath();
      const N = 120;
      for (let i = 0; i <= N; i++) {
        const ang = (i / N) * Math.PI * 2;
        const nz = noiseAt(ang);
        const r = (baseR * (0.8 + bass * 0.45) + nz * baseR * 0.13 * (0.4 + treble * 1.2) + level * baseR * 0.16) * scale;
        const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    path(0.72); ctx.fillStyle = 'rgba(214,160,40,0.15)'; ctx.fill();   // amber inner
    path(1);
    ctx.save();
    try { ctx.filter = `blur(${3 + Math.round(level * 4)}px)`; } catch {}
    ctx.strokeStyle = `rgba(255,227,74,${(0.3 + level * 0.3).toFixed(3)})`;
    ctx.lineWidth = 8 + level * 10; ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#FFE34A'; ctx.lineWidth = 2.5 + level * 2; ctx.stroke();
    ctx.strokeStyle = 'rgba(15,14,13,0.22)'; ctx.lineWidth = 1; ctx.stroke();

    const coreR = minDim * 0.028 * (0.6 + level * 1.2);
    ctx.globalAlpha = 0.45 + level * 0.3;
    ctx.fillStyle = '#FFE34A';
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// One-line renderer swap; default is the lead (Constellation).
export function createRenderer(name, opts = {}) {
  switch (name) {
    case 'cloud': return new CloudRenderer(opts);
    case 'blob':  return new BlobRenderer(opts);
    default:      return new ConstellationRenderer(opts);
  }
}
