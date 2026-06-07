// surface-nav.js — ONE shared primary navigation, injected on every app surface
// so the nav can never drift between pages again (the root cause of the old
// per-page divergence). Self-contained: brings its own styles with hardcoded
// brand fallbacks (pages use different css-var names, e.g. --mut vs --muted),
// renders the canonical item set, and marks the active item from the URL.
//
// Usage on a page: put <div id="app-surface-nav"></div> where the bar belongs,
// then <script src="/surface-nav.js" defer></script>. No per-page config.
//
// Scope note: this is the PRIMARY nav only. Each page keeps its own logo and
// top-right controls (the workspace switcher is tightly coupled to per-page data
// re-scoping; unifying that is a separate, larger task).

(function () {
  // Canonical top-level destinations, shown identically everywhere. `exact`
  // matches the path verbatim; `prefix` also matches sub-paths. Voice is exact
  // so /voice/connections does not light up Voice as well as Connections.
  var ITEMS = [
    { label: 'Store & Search', href: '/twin/chat',        prefix: ['/twin/chat'] },
    { label: 'Voice',          href: '/voice',            exact:  ['/voice', '/twin/voice'] },
    { label: 'Brain',          href: '/twin/library',     prefix: ['/twin/library', '/twin/brain'] },
    { label: 'Connections',    href: '/twin/connections', prefix: ['/twin/connections', '/voice/connections'] },
  ];

  function injectStyles() {
    if (document.getElementById('lx-surface-nav-styles')) return;
    var s = document.createElement('style');
    s.id = 'lx-surface-nav-styles';
    s.textContent = [
      '#app-surface-nav{display:flex;justify-content:center;padding:14px 16px;border-bottom:1px solid var(--line,#E4E0D8);background:var(--paper,#F5F3EF);box-sizing:border-box;}',
      '#app-surface-nav .lxnav-group{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;max-width:100%;background:var(--paper-3,#EDEAE2);border:1.5px solid var(--ink,#0F0E0D);border-radius:999px;padding:4px;box-shadow:2px 2px 0 var(--ink,#0F0E0D);box-sizing:border-box;}',
      "#app-surface-nav .lxnav-tab{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;padding:8px 18px;border-radius:999px;border:none;background:transparent;color:var(--muted,var(--mut,#6B6760));text-decoration:none;white-space:nowrap;cursor:pointer;}",
      '#app-surface-nav .lxnav-tab:hover:not(.active){color:var(--ink,#0F0E0D);background:var(--paper,#F5F3EF);}',
      '#app-surface-nav .lxnav-tab.active{background:var(--yellow,#FFE34A);color:var(--ink,#0F0E0D);border:1.5px solid var(--ink,#0F0E0D);margin:-1.5px;}',
      '@media(max-width:430px){#app-surface-nav{padding:10px 8px;}#app-surface-nav .lxnav-tab{padding:7px 12px;font-size:11px;letter-spacing:0.04em;}}',
      // A7: skip link — visually hidden until focused, first focusable on the page.
      '.lx-skip{position:fixed;top:-60px;left:8px;z-index:10000;background:var(--ink,#0F0E0D);color:#fff;padding:8px 14px;border-radius:8px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;font-weight:600;text-decoration:none;transition:top 120ms;}',
      '.lx-skip:focus{top:8px;outline:2px solid var(--yellow,#FFE34A);outline-offset:2px;}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function currentPath() {
    var p = (location.pathname || '/').replace(/\/+$/, '');
    return p === '' ? '/' : p;
  }

  function isActive(item, path) {
    if (item.exact && item.exact.indexOf(path) !== -1) return true;
    if (item.prefix && item.prefix.some(function (p) { return path === p || path.indexOf(p + '/') === 0; })) return true;
    return false;
  }

  function render() {
    var mount = document.getElementById('app-surface-nav');
    if (!mount) return;
    injectStyles();
    // A7: skip link as the first focusable element, targeting the page's main content.
    if (!document.querySelector('.lx-skip')) {
      var main = document.querySelector('main, [role="main"]') || document.getElementById('page');
      if (main) {
        if (!main.id) main.id = 'lx-main';
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        var mainId = main.id;
        var skip = document.createElement('a');
        skip.className = 'lx-skip';
        skip.href = '#' + mainId;
        skip.textContent = 'Skip to content';
        skip.addEventListener('click', function () { var m = document.getElementById(mainId); if (m) setTimeout(function () { m.focus(); }, 0); });
        document.body.insertBefore(skip, document.body.firstChild);
      }
    }
    var path = currentPath();
    var group = document.createElement('div');
    group.className = 'lxnav-group';
    group.setAttribute('role', 'navigation');
    group.setAttribute('aria-label', 'Main');
    ITEMS.forEach(function (item) {
      var a = document.createElement('a');
      a.className = 'lxnav-tab' + (isActive(item, path) ? ' active' : '');
      a.href = item.href;
      a.textContent = item.label;
      if (isActive(item, path)) a.setAttribute('aria-current', 'page');
      group.appendChild(a);
    });
    mount.textContent = '';
    mount.appendChild(group);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
