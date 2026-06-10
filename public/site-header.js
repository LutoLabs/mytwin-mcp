// site-header.js — ONE shared site header (logo + space switcher + account
// menu), injected on every app surface EXCEPT the dashboard (home.html).
// The dashboard keeps its own live header because its space switcher re-scopes
// the whole page in place (hero graph + widgets + feed); the markup and styles
// here are extracted from it verbatim so the two cannot drift visually.
//
// Usage on a page:
//   <header class="site-header" id="app-site-header"></header>
//   <script src="/brand.js" defer></script>
//   <script src="/site-header.js" defer></script>
//
// Optional page hooks, defined before this script runs:
//   window.__HEADER_HOOKS__ = {
//     signIn:   function () {...},   // open the page's own sign-in modal
//     saveTwin: function () {...},   // open the page's own claim modal
//   }
// Without hooks, the anon buttons route to the dashboard (/twin?signin=1 or
// /twin?save=1), which opens the matching modal on arrival.
//
// The space switcher here is navigational: choosing a space stashes it in
// sessionStorage('mt_home_space') and lands on /twin, where the dashboard's
// boot picks it up and scopes itself to that space. Live re-scoping stays on
// the dashboard only (see the scope note in surface-nav.js).
(function () {
  var mount = document.getElementById('app-site-header');
  if (!mount) return;

  var HOOKS = window.__HEADER_HOOKS__ || {};
  var BRAND = window.BRAND || { NAME: 'MyAITwin', BYLINE: 'by Luto' };

  // ── styles — extracted from home.html's header, namespaced under the id ──
  function injectStyles() {
    if (document.getElementById('lx-site-header-styles')) return;
    var s = document.createElement('style');
    s.id = 'lx-site-header-styles';
    s.textContent = [
      // Theme seams: pages without these vars fall back to the dashboard's
      // values; the dark profile page sets --header-bg and falls through
      // --card for menu surfaces.
      '#app-site-header{--sh-paper:var(--paper,var(--card,#FBFAF7));--sh-card:var(--card,#FFFFFF);--sh-surface:var(--surface,var(--paper-3,rgba(150,160,220,0.10)));--sh-ink:var(--ink,#0F0E0D);--sh-mut:var(--muted,var(--mut,#6B6760));--sh-line:var(--line,#E0DDD4);--sh-yellow:var(--yellow,#FFE34A);}',
      'header#app-site-header{position:sticky;top:0;z-index:40;border-bottom:1px solid var(--sh-line);background:var(--header-bg,rgba(251,250,247,0.9));backdrop-filter:blur(8px);}',
      '#app-site-header .header-inner{max-width:1080px;margin:0 auto;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;}',
      '#app-site-header a{text-decoration:none;color:inherit;}',
      '#app-site-header button{font:inherit;background:none;border:none;box-shadow:none;border-radius:0;cursor:pointer;color:inherit;padding:0;margin:0;text-transform:none;letter-spacing:normal;}',
      '#app-site-header .header-left{display:flex;align-items:center;gap:10px;min-width:0;}',
      '#app-site-header .logo{display:flex;align-items:center;gap:9px;}',
      '#app-site-header .logo-mark{position:relative;width:22px;height:22px;flex-shrink:0;background:none;border:none;box-shadow:none;border-radius:0;}',
      "#app-site-header .logo-mark::before{content:'';position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:3px;background:var(--sh-ink);opacity:.32;}",
      "#app-site-header .logo-mark::after{content:'';position:absolute;top:0;left:0;width:20px;height:20px;border-radius:3px;background:var(--sh-yellow);border:1.5px solid var(--sh-ink);}",
      '#app-site-header .logo-text{display:flex;flex-direction:column;gap:1px;}',
      "#app-site-header .logo-name{font-family:'Source Serif 4',Georgia,serif;font-size:1.05rem;font-weight:600;letter-spacing:-0.01em;line-height:1.1;color:var(--sh-ink);margin:0;}",
      "#app-site-header .logo-by{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:7px;font-weight:600;text-transform:uppercase;letter-spacing:0.2em;color:var(--sh-mut);line-height:1;}",
      // space switcher
      '#app-site-header .space-switcher{position:relative;}',
      "#app-site-header .space-trigger{display:flex;align-items:center;gap:7px;padding:6px 10px;border:1.5px solid var(--sh-ink);border-radius:8px;background:var(--sh-card);box-shadow:2px 2px 0 var(--sh-ink);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:600;color:var(--sh-ink);max-width:210px;transition:background 120ms;}",
      '#app-site-header .space-trigger:hover{background:var(--sh-surface);}',
      '#app-site-header .sp-dot{width:9px;height:9px;border-radius:3px;flex-shrink:0;border:1.5px solid var(--sh-ink);background:var(--sh-yellow);}',
      '#app-site-header .space-trigger .sp-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '#app-site-header .space-trigger .sp-caret{color:var(--sh-mut);flex-shrink:0;}',
      '#app-site-header .space-menu{position:absolute;left:0;top:calc(100% + 6px);background:var(--sh-paper);border:1.5px solid var(--sh-ink);border-radius:10px;box-shadow:3px 3px 0 var(--sh-ink);min-width:252px;z-index:120;overflow:hidden;padding:5px;}',
      "#app-site-header .space-group-label{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:8.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--sh-mut);padding:8px 9px 4px;}",
      '#app-site-header .space-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 9px;border-radius:7px;font-size:13px;color:var(--sh-ink);text-align:left;cursor:pointer;background:none;border:none;}',
      '#app-site-header .space-item:hover{background:var(--sh-surface);}',
      '#app-site-header .space-item.active{background:var(--sh-surface);}',
      '#app-site-header .space-item .sp-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      "#app-site-header .space-item .sp-meta{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;color:var(--sh-mut);flex-shrink:0;}",
      "#app-site-header .space-item .sp-manage{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;color:var(--sh-mut);text-decoration:underline;flex-shrink:0;}",
      '#app-site-header .space-item .sp-manage:hover{color:var(--sh-ink);}',
      '#app-site-header .space-item.teamspace{padding-left:26px;}',
      '#app-site-header .space-item.teamspace .sp-dot{width:6px;height:6px;border-radius:2px;}',
      '#app-site-header .space-item.teamspace .sp-name{font-size:12.5px;}',
      '#app-site-header .space-divider{height:1px;background:var(--sh-line);margin:5px 4px;}',
      "#app-site-header .space-action{display:flex;align-items:center;width:100%;padding:8px 9px;border-radius:7px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--sh-mut);background:none;border:none;text-align:left;cursor:pointer;}",
      '#app-site-header .space-action:hover{background:var(--sh-surface);color:var(--sh-ink);}',
      // anon buttons
      '#app-site-header .anon-btns{display:flex;align-items:center;gap:8px;}',
      "#app-site-header .signin-link{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--sh-mut);padding:7px 10px;transition:color 150ms;}",
      '#app-site-header .signin-link:hover{color:var(--sh-ink);}',
      "#app-site-header .save-twin-btn{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:600;letter-spacing:0.04em;color:#0F0E0D;background:var(--sh-yellow);border:1.5px solid var(--sh-ink);border-radius:8px;padding:7px 12px;box-shadow:2px 2px 0 var(--sh-ink);transition:transform 120ms,box-shadow 120ms;}",
      '#app-site-header .save-twin-btn:hover{transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--sh-ink);}',
      // account menu
      '#app-site-header .account-indicator{position:relative;}',
      '#app-site-header .account-trigger{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:8px;transition:background 120ms;}',
      '#app-site-header .account-trigger:hover{background:var(--sh-surface);}',
      "#app-site-header .acct-avatar{width:26px;height:26px;background:var(--sh-ink);color:var(--sh-paper);border-radius:7px;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:700;flex-shrink:0;user-select:none;}",
      '#app-site-header .acct-caret{color:var(--sh-mut);flex-shrink:0;}',
      '#app-site-header .account-dropdown{position:absolute;right:0;top:calc(100% + 6px);background:var(--sh-paper);border:1.5px solid var(--sh-ink);border-radius:10px;box-shadow:3px 3px 0 var(--sh-ink);min-width:200px;z-index:100;overflow:hidden;}',
      "#app-site-header .acct-dropdown-email{padding:11px 14px 10px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;font-weight:600;letter-spacing:0.04em;color:var(--sh-mut);border-bottom:1px solid var(--sh-line);word-break:break-all;}",
      "#app-site-header .acct-dropdown-item{display:block;width:100%;padding:10px 14px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--sh-ink);border-top:1px solid var(--sh-line);text-align:left;transition:background 100ms;}",
      '#app-site-header .acct-dropdown-item:first-child{border-top:none;}',
      '#app-site-header .acct-dropdown-item:hover{background:var(--sh-surface);}',
      '@media (max-width:520px){#app-site-header .space-trigger{max-width:130px;}#app-site-header .space-trigger .sp-name{max-width:80px;}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── tiny helpers ──────────────────────────────────────────────────────────
  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function $(id) { return document.getElementById(id); }
  var anonToken = null;
  try { anonToken = localStorage.getItem('mt_anon_token'); } catch (e) {}
  function fetchJSON(url) {
    var headers = anonToken ? { 'X-Anon-Token': anonToken } : {};
    return fetch(url, { headers: headers, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function dotColor(kind) {
    return kind === 'shared' ? '#0B6E5E'
      : kind === 'teamspace' ? '#7A5CFF'
      : kind === 'workspace' ? 'var(--sh-ink)'
      : 'var(--sh-yellow)';
  }

  // ── render ────────────────────────────────────────────────────────────────
  function render() {
    injectStyles();
    mount.innerHTML =
      '<div class="header-inner">' +
        '<div class="header-left">' +
          '<a href="/twin" class="logo" aria-label="' + esc(BRAND.NAME) + ' home">' +
            '<span class="logo-mark"></span>' +
            '<span class="logo-text">' +
              '<span class="logo-name">' + esc(BRAND.NAME) + '</span>' +
              '<span class="logo-by">' + esc(BRAND.BYLINE) + '</span>' +
            '</span>' +
          '</a>' +
          '<div class="space-switcher" id="sh-space-switcher" hidden>' +
            '<button type="button" class="space-trigger" id="sh-space-trigger" aria-haspopup="true" aria-expanded="false">' +
              '<span class="sp-dot" id="sh-sp-cur-dot"></span>' +
              '<span class="sp-name" id="sh-sp-cur-name">Personal</span>' +
              '<svg class="sp-caret" width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button>' +
            '<div class="space-menu" id="sh-space-menu" hidden role="menu"></div>' +
          '</div>' +
        '</div>' +
        '<div id="sh-anon-btns" class="anon-btns" hidden>' +
          '<button type="button" class="signin-link" id="sh-signin-btn">Sign in</button>' +
          '<button type="button" class="save-twin-btn" id="sh-save-twin-btn">Save your twin →</button>' +
        '</div>' +
        '<div id="sh-account-indicator" class="account-indicator" hidden>' +
          '<button type="button" class="account-trigger" id="sh-account-trigger" aria-haspopup="true" aria-expanded="false">' +
            '<span class="acct-avatar" id="sh-acct-avatar" aria-hidden="true"></span>' +
            '<svg class="acct-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<div id="sh-account-dropdown" class="account-dropdown" hidden role="menu">' +
            '<div class="acct-dropdown-email" id="sh-acct-email"></div>' +
            '<a href="/twin/profile" class="acct-dropdown-item" role="menuitem">Profile</a>' +
            '<a href="/twin/profile#settings" class="acct-dropdown-item" role="menuitem">Settings</a>' +
            '<button type="button" id="sh-sign-out" class="acct-dropdown-item" role="menuitem">Sign out</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    wire();
  }

  // ── auth state ────────────────────────────────────────────────────────────
  var state = { isAuth: false, email: null };

  function updateAuthDisplay() {
    var anonB = $('sh-anon-btns'), acct = $('sh-account-indicator');
    if (state.isAuth) {
      anonB.hidden = true;
      acct.hidden = false;
      var initial = (state.email || '·').trim().charAt(0).toUpperCase() || '·';
      $('sh-acct-avatar').textContent = initial;
      $('sh-acct-email').textContent = state.email || '';
    } else {
      acct.hidden = true;
      anonB.hidden = false;
    }
  }

  function validateSession() {
    return fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.is_authenticated && d.email) {
          state.isAuth = true; state.email = d.email;
          try {
            localStorage.setItem('mt_is_authenticated', 'true');
            localStorage.setItem('mt_user_email', d.email);
          } catch (e) {}
        } else {
          state.isAuth = false;
          try {
            localStorage.removeItem('mt_is_authenticated');
            localStorage.removeItem('mt_user_email');
          } catch (e) {}
        }
        updateAuthDisplay();
      })
      .catch(function () {});
  }

  // ── space switcher (navigational) ─────────────────────────────────────────
  var spaces = { workspaces: [], teamspacesByWs: {}, hasShares: false, list: [] };

  function loadSpaces() {
    Promise.all([fetchJSON('/api/workspaces'), fetchJSON('/api/library/shared')]).then(function (res) {
      spaces.workspaces = (res[0] && res[0].workspaces) || [];
      spaces.hasShares = !!(res[1] && res[1].items && res[1].items.length);
      renderSwitcher();
      spaces.teamspacesByWs = {};
      if (spaces.workspaces.length) {
        Promise.all(spaces.workspaces.map(function (w) {
          return fetchJSON('/api/workspaces/' + encodeURIComponent(w.id) + '/groups')
            .then(function (g) { spaces.teamspacesByWs[w.id] = (g && g.groups) || []; });
        })).then(renderSwitcher);
      }
    });
  }

  function spaceItem(idx, space, meta, manage) {
    var right = manage ? '<span class="sp-manage" role="link">manage</span>'
      : (meta ? '<span class="sp-meta">' + esc(meta) + '</span>' : '');
    var cls = 'space-item' + (space.kind === 'teamspace' ? ' teamspace' : '');
    return '<div class="' + cls + '" role="menuitem" tabindex="0" data-idx="' + idx + '">' +
      '<span class="sp-dot" style="background:' + dotColor(space.kind) + '"></span>' +
      '<span class="sp-name">' + esc(space.name) + '</span>' + right + '</div>';
  }

  function renderSwitcher() {
    if (!state.isAuth && !anonToken) return;
    $('sh-space-switcher').hidden = false;
    spaces.list = [];
    function push(space, meta, manage) { var idx = spaces.list.push(space) - 1; return spaceItem(idx, space, meta, manage); }
    var html = '<div class="space-group-label">Your space</div>';
    html += push({ kind: 'personal', name: 'Personal' }, 'your twin', false);
    html += push({ kind: 'shared', name: 'Shared with you' }, spaces.hasShares ? 'items' : 'nothing yet', false);
    if (spaces.workspaces.length) {
      html += '<div class="space-divider"></div><div class="space-group-label">Workspaces</div>';
      spaces.workspaces.forEach(function (w) {
        var canManage = w.role === 'owner' || w.role === 'admin';
        var meta = (typeof w.member_count === 'number' ? w.member_count + ' · ' : '') + (w.role || '');
        html += push({ kind: 'workspace', id: w.id, name: w.name, role: w.role }, meta, canManage);
        var ts = (spaces.teamspacesByWs && spaces.teamspacesByWs[w.id]) || [];
        if (!Array.isArray(ts)) ts = ts.groups || [];
        ts.forEach(function (g) {
          var openness = g.openness || 'closed';
          var tmeta = (typeof g.member_count === 'number' ? g.member_count + ' · ' : '') + openness;
          html += push({ kind: 'teamspace', id: w.id, groupId: g.id, name: g.name, role: w.role, you_are_in: !!g.you_are_in, openness: openness }, tmeta, false);
        });
      });
    }
    html += '<div class="space-divider"></div><button type="button" class="space-action" id="sh-space-new">+ New workspace</button>';
    var menu = $('sh-space-menu');
    menu.innerHTML = html;
    // Personal is "where /twin lands", so it reads as the current space here.
    var first = menu.querySelector('.space-item');
    if (first) first.classList.add('active');
    function activate(it) {
      var sp = spaces.list[+it.getAttribute('data-idx')];
      if (!sp) return;
      menu.hidden = true;
      $('sh-space-trigger').setAttribute('aria-expanded', 'false');
      // Hand the chosen space to the dashboard, which scopes itself on boot.
      try { sessionStorage.setItem('mt_home_space', JSON.stringify(sp)); } catch (e) {}
      location.href = '/twin';
    }
    menu.querySelectorAll('.space-item').forEach(function (it) {
      it.addEventListener('click', function () { activate(it); });
      it.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(it); }
      });
    });
    menu.querySelectorAll('.sp-manage').forEach(function (m) {
      m.addEventListener('click', function (e) { e.stopPropagation(); location.href = '/twin/profile#workspaces'; });
    });
    var nb = $('sh-space-new');
    if (nb) nb.addEventListener('click', function () { location.href = '/twin/profile#workspaces'; });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  function wire() {
    // Anon buttons: page hooks first (twin chat has its own modals), else the
    // dashboard opens the matching modal from the query param.
    $('sh-signin-btn').addEventListener('click', function () {
      if (typeof HOOKS.signIn === 'function') return HOOKS.signIn();
      location.href = '/twin?signin=1';
    });
    $('sh-save-twin-btn').addEventListener('click', function () {
      if (typeof HOOKS.saveTwin === 'function') return HOOKS.saveTwin();
      location.href = '/twin?save=1';
    });

    // Account dropdown.
    var trigger = $('sh-account-trigger'), dropdown = $('sh-account-dropdown');
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = dropdown.hidden === false;
      dropdown.hidden = open;
      trigger.setAttribute('aria-expanded', String(!open));
    });
    $('sh-sign-out').addEventListener('click', function () {
      try {
        localStorage.removeItem('mt_is_authenticated');
        localStorage.removeItem('mt_user_email');
        localStorage.removeItem('mt_anon_token');
      } catch (e) {}
      fetch('/api/auth/signout', { method: 'POST' }).finally(function () { location.href = '/twin'; });
    });

    // Space switcher trigger.
    var spTrig = $('sh-space-trigger'), spMenu = $('sh-space-menu');
    spTrig.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = spMenu.hidden === false;
      spMenu.hidden = open;
      spTrig.setAttribute('aria-expanded', String(!open));
    });

    // Close menus on outside click / Escape.
    document.addEventListener('click', function () {
      if (!dropdown.hidden) { dropdown.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
      if (!spMenu.hidden) { spMenu.hidden = true; spTrig.setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!dropdown.hidden) { dropdown.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
      if (!spMenu.hidden) { spMenu.hidden = true; spTrig.setAttribute('aria-expanded', 'false'); }
    });

    // Instant identity guess so a signed-in owner never flashes the anonymous
    // header; the session fetch confirms or corrects it (same pattern as the
    // dashboard).
    try {
      state.isAuth = localStorage.getItem('mt_is_authenticated') === 'true';
      state.email = localStorage.getItem('mt_user_email') || null;
    } catch (e) {}
    updateAuthDisplay();
    validateSession().then(function () {
      updateAuthDisplay();
      loadSpaces();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
