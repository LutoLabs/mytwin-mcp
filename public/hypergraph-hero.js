/* ──────────────────────────────────────────────────────────────────────────
   hypergraph-hero.js — the live hypergraph, as a reusable hero.

   This is the SAME three.js renderer the Profile page uses (profile.html's
   renderHypergraph), lifted into a module so the home can mount it as a calm
   hero band and expand it to a full-screen immersive view. Parameterised:
     • the container is passed in (no hard-coded #hypergraph-container)
     • the tooltip is created + scoped here (no shared #tip)
     • real nodes are clickable → opts.onNodeClick(node)   (new for the home)
     • the renderer can be resized on demand → handle.resize()  (for immersion)
   The profile-only "placeholder ghost" seeding machinery is intentionally
   dropped; the home handles its own cold-start (HypergraphHero.ghost).

   Requires THREE (r128) loaded globally before mount().
   Exposes window.HypergraphHero = { mount, ghost }.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Domain palette — numeric for three.js, tuned for a dark surface.
  // Mirrors profile.html's DOMAIN_COLOR.
  // The graph is fully data-driven: domain names AND colours come from the API
  // payload (graph.domains[name].color, a "0xRRGGBB" string). This index-based
  // palette is only a fallback for domains the backend ships without a colour,
  // so an unfamiliar taxonomy (e.g. a workspace's own domains) still gets
  // distinct hues instead of collapsing to one. Nothing is keyed by a baked-in
  // domain name.
  var FALLBACK_PALETTE = [0xFFD400, 0x00E0C6, 0xFF3D8B, 0x5B8CFF, 0xFF7A1A, 0xA85CFF, 0x4DD0E1, 0xE6E64D, 0x9CCC65, 0xFF8A65];
  function parseApiColor(c) {
    if (typeof c === 'number' && isFinite(c)) return c;
    if (typeof c === 'string') { var n = parseInt(c.replace(/^0x/i, '').replace(/^#/, ''), 16); if (isFinite(n)) return n; }
    return null;
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  // A body-level tooltip so it is never clipped by the hero's overflow:hidden.
  function makeTip() {
    var tip = document.createElement('div');
    tip.className = 'hg-tip';
    tip.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'pointer-events:none',
      'padding:11px 14px', 'border-radius:10px',
      'background:rgba(9,11,24,0.92)', 'border:1px solid rgba(150,160,220,0.2)',
      '-webkit-backdrop-filter:blur(12px)', 'backdrop-filter:blur(12px)',
      'font-family:"JetBrains Mono",ui-monospace,monospace',
      'font-size:12px', 'color:#eef0ff', 'max-width:280px',
      'opacity:0', 'transform:translateY(5px)',
      'transition:opacity .14s, transform .14s',
    ].join(';');
    document.body.appendChild(tip);
    return tip;
  }

  /* mount(container, graph, opts) → { dispose, resize }
     graph: the /api/profile/hypergraph payload { nodes, edges, domains }
     opts:  { onNodeClick(node) } */
  function mount(container, graph, opts) {
    opts = opts || {};
    var onNodeClick = typeof opts.onNodeClick === 'function' ? opts.onNodeClick : null;
    var SPREAD = 50, JITTER_MULT = 23, GAP = 2.0, ITER = 120;

    // Build the item shape the renderer needs from the API payload. Domain names,
    // colours and membership all come from graph.domains — never assumed.
    var apiNodes = graph.nodes || [];
    var domains = graph.domains || {};
    var domainNames = Object.keys(domains);
    if (!domainNames.length) domainNames = ['_'];   // ungrouped graph → one synthetic domain
    var domainColor = {};
    domainNames.forEach(function (d, i) {
      var c = domains[d] ? parseApiColor(domains[d].color) : null;
      domainColor[d] = (c != null) ? c : FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
    });
    var nodeDomain = new Array(apiNodes.length).fill(domainNames[0]);
    domainNames.forEach(function (d) {
      if (!domains[d]) return;
      (domains[d].node_ids || []).forEach(function (i) {
        if (i >= 0 && i < apiNodes.length) nodeDomain[i] = d;
      });
    });
    var tagSets = apiNodes.map(function (n) {
      return new Set((n.tags || []).map(function (t) { return String(t).toLowerCase(); }));
    });
    function siblingsOf(i) {
      var out = [];
      for (var j = 0; j < tagSets.length; j++) {
        if (j === i) continue;
        var hit = false;
        tagSets[i].forEach(function (t) { if (tagSets[j].has(t)) hit = true; });
        if (hit) out.push(j);
      }
      return out;
    }
    var ITEMS = apiNodes.map(function (n, idx) {
      return {
        id: n.id,
        title: n.title || '(untitled)',
        type: n.type || '',
        domain: nodeDomain[idx],
        tags: n.tags || [],
        degree: n.degree || 0,
        idx: idx,
        siblings: siblingsOf(idx),
      };
    });
    var EDGES = (graph.edges || []).filter(function (e) {
      return e.i >= 0 && e.j >= 0 && e.i < ITEMS.length && e.j < ITEMS.length && e.i !== e.j;
    });

    // Scene / camera / renderer (container-scoped).
    var scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05060e, 0.005);
    var camera = new THREE.PerspectiveCamera(58, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 4000);
    camera.position.set(0, 0, 150);
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    var dom = renderer.domElement;
    dom.style.display = 'block';
    dom.style.cursor = 'grab';
    container.appendChild(dom);

    scene.add(new THREE.AmbientLight(0x404a66, 1.1));
    var key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1, 1.2, 1); scene.add(key);
    var fill = new THREE.DirectionalLight(0x88aaff, 0.5); fill.position.set(-1, -0.5, -0.5); scene.add(fill);
    var group = new THREE.Group(); scene.add(group);

    // Domain anchors (golden-ratio spread), over the payload's actual domains.
    var domainAnchor = {};
    var nDomains = domainNames.length;
    domainNames.forEach(function (d, i) {
      var golden = 2.399963;
      var y = (nDomains > 1) ? (1 - (i / (nDomains - 1)) * 2) : 0;
      var r = Math.sqrt(Math.max(0, 1 - y * y));
      var th = golden * i;
      domainAnchor[d] = new THREE.Vector3(Math.cos(th) * r, y * 0.85, Math.sin(th) * r).multiplyScalar(SPREAD);
    });

    function hashVec(s) {
      var h = 0;
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      var a = (h % 1000) / 1000 * 6.283;
      var b = ((h >>> 10) % 1000) / 1000 * Math.PI;
      return new THREE.Vector3(Math.sin(b) * Math.cos(a), Math.sin(b) * Math.sin(a), Math.cos(b));
    }

    function makeHalo() {
      var S = 128;
      var c = document.createElement('canvas'); c.width = c.height = S;
      var g = c.getContext('2d');
      var grd = g.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S / 2);
      grd.addColorStop(0, 'rgba(255,255,255,0.5)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.12)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, S, S);
      return new THREE.CanvasTexture(c);
    }
    var haloTex = makeHalo();

    var nodes = [];
    var maxDeg = Math.max.apply(null, [1].concat(ITEMS.map(function (it) { return it.degree; })));
    ITEMS.forEach(function (it) {
      var anchor = domainAnchor[it.domain] || domainAnchor[domainNames[0]];
      var v = anchor.clone();
      v.add(hashVec(String(it.id)).multiplyScalar(JITTER_MULT));
      var col = new THREE.Color(domainColor[it.domain] != null ? domainColor[it.domain] : FALLBACK_PALETTE[0]);
      var size = 2.2 + (it.degree / maxDeg) * 2.6;
      var mat = new THREE.MeshStandardMaterial({
        color: col, emissive: col.clone().multiplyScalar(0.35), roughness: 0.45, metalness: 0.1,
      });
      var body = new THREE.Mesh(new THREE.SphereGeometry(size, 32, 32), mat);
      var halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: haloTex, color: col, transparent: true,
        blending: THREE.AdditiveBlending, opacity: 0.4, depthWrite: false,
      }));
      var hs = size * 3.2;
      halo.scale.set(hs, hs, 1);
      body.position.copy(v); halo.position.copy(v);
      group.add(body); group.add(halo);
      nodes.push({
        it: it, body: body, halo: halo, mat: mat, color: col.getHex(),
        baseEmissive: 0.35, baseSize: size, baseHalo: hs, base: v.clone(), glow: 0,
      });
    });

    // Separation relaxation.
    (function relax() {
      for (var pass = 0; pass < ITER; pass++) {
        var moved = false;
        for (var i = 0; i < nodes.length; i++) {
          for (var j = i + 1; j < nodes.length; j++) {
            var a = nodes[i].base, b = nodes[j].base;
            var need = nodes[i].baseSize + nodes[j].baseSize + GAP;
            var dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < 1e-4) { b.x += 0.5; b.y -= 0.3; b.z += 0.2; d = 0.6; }
            if (d < need) {
              var push = (need - d) / 2;
              var ux = dx / d, uy = dy / d, uz = dz / d;
              a.x -= ux * push; a.y -= uy * push; a.z -= uz * push;
              b.x += ux * push; b.y += uy * push; b.z += uz * push;
              moved = true;
            }
          }
        }
        if (!moved) break;
      }
      nodes.forEach(function (n) { n.body.position.copy(n.base); n.halo.position.copy(n.base); });
    })();

    // Edges (cylinders).
    var _up = new THREE.Vector3(0, 1, 0);
    var edges = [];
    var maxSh = Math.max.apply(null, [1].concat(EDGES.map(function (e) { return e.strength; })));
    EDGES.forEach(function (e) {
      var strength = e.strength / maxSh;
      var blend = new THREE.Color(nodes[e.i].color).lerp(new THREE.Color(nodes[e.j].color), 0.5);
      var r = 0.08 + strength * 0.10;
      var op = 0.22 + strength * 0.25;
      var mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, 1, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: blend, transparent: true, opacity: op, depthWrite: false })
      );
      group.add(mesh);
      edges.push({ e: e, mesh: mesh, baseOp: op });
    });
    function orient(mesh, a, b) {
      var dir = new THREE.Vector3().subVectors(b, a);
      var len = dir.length();
      mesh.position.copy(a).addScaledVector(dir, 0.5);
      mesh.scale.set(1, len, 1);
      mesh.quaternion.setFromUnitVectors(_up, dir.clone().normalize());
    }
    edges.forEach(function (ed) { orient(ed.mesh, nodes[ed.e.i].base, nodes[ed.e.j].base); });

    // Starfield.
    var sg = new THREE.BufferGeometry();
    var sn = 600;
    var sp = new Float32Array(sn * 3);
    for (var si = 0; si < sn; si++) {
      var rr = 320 + Math.random() * 800;
      var tt = Math.random() * 6.28;
      var pp = Math.acos(2 * Math.random() - 1);
      sp.set([rr * Math.sin(pp) * Math.cos(tt), rr * Math.sin(pp) * Math.sin(tt), rr * Math.cos(pp)], si * 3);
    }
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({
      color: 0x8088bb, size: 1.1, transparent: true, opacity: 0.5,
    })));

    // Interaction — all window listeners share one AbortController for teardown.
    var ac = new AbortController();
    var sig = ac.signal;
    var userRotX = 0.15, userRotY = 0;
    var dragging = false, lastX = 0, lastY = 0;
    var tZoom = 150;
    var autoYaw = 0;
    var downX = 0, downY = 0;

    dom.addEventListener('pointerdown', function (e) {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      downX = e.clientX; downY = e.clientY;
      document.body.classList.add('hg-grabbing');
    }, { signal: sig });
    window.addEventListener('pointerup', function (e) {
      dragging = false; document.body.classList.remove('hg-grabbing');
      // A click (negligible drag) on a real node opens it.
      if (hovered && onNodeClick && Math.hypot(e.clientX - downX, e.clientY - downY) < 5) {
        onNodeClick(hovered.it);
      }
    }, { signal: sig });
    window.addEventListener('pointermove', function (e) {
      hover(e);
      if (!dragging) return;
      userRotY += (e.clientX - lastX) * 0.005;
      userRotX += (e.clientY - lastY) * 0.005;
      userRotX = Math.max(-1.4, Math.min(1.4, userRotX));
      lastX = e.clientX; lastY = e.clientY;
    }, { signal: sig });
    dom.addEventListener('wheel', function (e) {
      e.preventDefault();
      tZoom += e.deltaY * 0.06;
      tZoom = Math.max(70, Math.min(300, tZoom));
    }, { passive: false, signal: sig });

    // Hover tooltip. Titles are user data — built with textContent (injection-safe).
    var ray = new THREE.Raycaster();
    var mvec = new THREE.Vector2();
    var tip = makeTip();
    var hovered = null;
    function hideTip() { tip.style.opacity = 0; tip.style.transform = 'translateY(5px)'; }
    function hover(e) {
      var rect = dom.getBoundingClientRect();
      var x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        hovered = null; hideTip();
        dom.style.cursor = dragging ? 'grabbing' : 'grab';
        return;
      }
      mvec.x = (x / rect.width) * 2 - 1;
      mvec.y = -(y / rect.height) * 2 + 1;
      ray.setFromCamera(mvec, camera);
      var hits = ray.intersectObjects(nodes.map(function (n) { return n.body; }), false);
      if (hits.length) {
        var hit = hits[0].object;
        var n = null;
        for (var i = 0; i < nodes.length; i++) { if (nodes[i].body === hit) { n = nodes[i]; break; } }
        hovered = n;
        tip.style.left = (e.clientX + 16) + 'px';
        tip.style.top = (e.clientY + 14) + 'px';
        var c = '#' + new THREE.Color(n.color).getHexString();
        var head = document.createElement('div');
        head.style.cssText = 'font-size:9px;letter-spacing:.2em;text-transform:uppercase;margin-bottom:4px;color:' + c;
        head.textContent = n.it.domain + ' · ' + plural(n.it.degree, 'link');
        var title = document.createElement('div');
        title.style.cssText = 'font-family:"Source Serif 4",Georgia,serif;font-size:13px;line-height:1.4;';
        title.textContent = n.it.title;
        var tg = document.createElement('div');
        tg.style.cssText = 'margin-top:7px;font-size:9.5px;color:#8088bb;letter-spacing:.04em;line-height:1.6;';
        tg.textContent = n.it.tags.slice(0, 7).join('  ·  ');
        tip.replaceChildren(head, title, tg);
        tip.style.opacity = 1; tip.style.transform = 'translateY(0)';
        dom.style.cursor = onNodeClick ? 'pointer' : 'grab';
        return;
      }
      hovered = null;
      hideTip();
      dom.style.cursor = dragging ? 'grabbing' : 'grab';
    }

    // Animation loop.
    var clock = new THREE.Clock();
    var running = true;
    (function animate() {
      if (!running) return;
      requestAnimationFrame(animate);
      var dt = Math.min(clock.getDelta(), 0.05);
      autoYaw += dt * 0.05;
      group.rotation.y = userRotY + autoYaw;
      group.rotation.x = userRotX;
      camera.position.z += (tZoom - camera.position.z) * 0.06;
      var hn = hovered ? new Set(hovered.it.siblings) : null;
      nodes.forEach(function (n, i) {
        var tg = 0;
        if (hovered) { if (n === hovered) tg = 1; else if (hn.has(i)) tg = 0.5; }
        n.glow += (tg - n.glow) * 0.2;
        n.body.scale.setScalar(1 + n.glow * 0.35);
        n.mat.emissive.setHex(n.color);
        n.mat.emissive.multiplyScalar(n.baseEmissive + n.glow * 0.5);
        var dim = (hovered && n !== hovered && !hn.has(i)) ? 0.5 : 1;
        n.mat.opacity = dim; n.mat.transparent = dim < 1;
        n.halo.material.opacity = (0.35 + n.glow * 0.5) * dim;
        n.halo.scale.setScalar(n.baseHalo * (1 + n.glow * 0.3));
      });
      edges.forEach(function (ed) {
        var op = ed.baseOp;
        if (hovered) {
          var on = (ed.e.i === hovered.it.idx || ed.e.j === hovered.it.idx);
          op = on ? Math.min(0.9, ed.baseOp * 2.4) : ed.baseOp * 0.25;
        }
        ed.mesh.material.opacity = op;
      });
      renderer.render(scene, camera);
    })();

    function resize() {
      var w = container.clientWidth, h = Math.max(1, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', resize, { signal: sig });

    return {
      resize: resize,
      dispose: function () {
        running = false;
        ac.abort();
        hideTip();
        if (tip.parentNode) tip.parentNode.removeChild(tip);
        renderer.dispose();
        if (dom.parentNode) dom.parentNode.removeChild(dom);
      },
    };
  }

  /* ghost(container, opts) — the cold-start "coalesce" state: faint hollow nodes
     in labelled clusters, barely breathing, no connections yet. Not real data —
     an invitation. Vanilla SVG so it needs no THREE. Returns { dispose }. */
  function ghost(container, opts) {
    opts = opts || {};
    var SVGNS = 'http://www.w3.org/2000/svg';
    function el(name, attrs) {
      var e = document.createElementNS(SVGNS, name);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }
    var W = 1040, H = 180, CX = 520, CY = 90;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var clusters = opts.labels || ['ideas', 'voice', 'decisions', 'taste', 'people'];
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid slice' });
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'display:block;width:100%;height:100%;';
    var rings = [];
    clusters.forEach(function (label, i) {
      var ang = (-Math.PI / 2) + (i / clusters.length) * Math.PI * 2;
      var cx = CX + Math.cos(ang) * 330, cy = CY + Math.sin(ang) * 52;
      var count = 3 + Math.floor(Math.random() * 3);
      for (var k = 0; k < count; k++) {
        var a = Math.random() * Math.PI * 2, rad = 12 + Math.random() * 34;
        var x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad * 0.7;
        var c = el('circle', { cx: x, cy: y, r: 3 + Math.random() * 3, fill: 'none', stroke: 'rgba(160,170,220,0.55)', 'stroke-width': 1.1, opacity: 0.5 });
        svg.appendChild(c);
        rings.push({ el: c, ph: Math.random() * 6.28 });
      }
      var t = el('text', { x: cx, y: cy + 44, 'text-anchor': 'middle' });
      t.setAttribute('style', 'font-family:"JetBrains Mono",ui-monospace,monospace;font-size:8px;text-transform:uppercase;letter-spacing:.18em;fill:rgba(140,150,200,0.55);');
      t.textContent = label;
      svg.appendChild(t);
    });
    container.innerHTML = '';
    container.appendChild(svg);
    var raf = null;
    if (!reduce) {
      (function breathe(ts) {
        for (var i = 0; i < rings.length; i++) {
          rings[i].el.setAttribute('opacity', (0.28 + 0.22 * (0.5 + 0.5 * Math.sin(ts * 0.0008 + rings[i].ph))).toFixed(3));
        }
        raf = requestAnimationFrame(breathe);
      })(0);
    }
    return {
      dispose: function () { if (raf) cancelAnimationFrame(raf); if (svg.parentNode) svg.parentNode.removeChild(svg); },
    };
  }

  window.HypergraphHero = { mount: mount, ghost: ghost };
})();
