// share-modal.js — one reusable Share dialog for every surface (library item,
// concept page, chat answer). Exposes window.openShareModal(opts).
//
//   openShareModal({
//     resourceType: 'item' | 'concept' | 'answer',
//     resourceId,                       // item/concept id (omit for answer)
//     title,                            // shown in the "what becomes visible" line
//     answer: { content, title },       // required when resourceType === 'answer'
//     modes,                            // optional override, default by type below
//   })
//
// Two modes: "Invite by email" (items only — the existing 5-level person-to-person
// flow) and "Public link" (link-to-anyone, read-only). Default is private:
// nothing is public until the user explicitly creates a link, and the dialog
// shows exactly what becomes visible before they confirm. No em dashes anywhere.

(function () {
  if (window.LutoShare) return; // idempotent

  // ── self-contained fetch (works with session cookie OR anon token) ──────────
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    try { const t = localStorage.getItem('mt_anon_token'); if (t) headers['X-Anon-Token'] = t; } catch (e) {}
    const res = await fetch(path, {
      method: opts.method || 'GET',
      credentials: 'include',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok) { const err = new Error((data && data.error) || ('Request failed (' + res.status + ')')); err.status = res.status; throw err; }
    return data || {};
  }

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function ensureStyles() {
    if (document.getElementById('share-modal-styles')) return;
    const s = el('style'); s.id = 'share-modal-styles';
    s.textContent = `
    .shm-overlay{position:fixed;inset:0;background:rgba(15,14,13,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;}
    .shm-card{background:var(--card,#fff);color:var(--ink,#0f0e0d);width:100%;max-width:460px;border-radius:14px;border:1px solid var(--line,#e7e2d9);box-shadow:0 24px 60px rgba(0,0,0,.28);overflow:hidden;font-family:inherit;}
    .shm-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 0;}
    .shm-title{font-family:'Source Serif 4',Georgia,serif;font-size:19px;font-weight:600;margin:0;}
    .shm-x{background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:var(--muted,#8a8478);padding:2px 6px;border-radius:6px;}
    .shm-x:hover{background:var(--wash,#f4f1ea);}
    .shm-tabs{display:flex;gap:6px;padding:14px 20px 0;}
    .shm-tab{flex:1;padding:9px 10px;border:1px solid var(--line,#e7e2d9);background:var(--wash,#f7f4ee);border-radius:9px;font:600 11px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#6b6459);cursor:pointer;}
    .shm-tab.active{background:var(--ink,#0f0e0d);color:#fff;border-color:var(--ink,#0f0e0d);}
    .shm-body{padding:16px 20px 20px;}
    .shm-note{font-size:13.5px;line-height:1.5;color:var(--muted,#6b6459);margin:0 0 14px;}
    .shm-note b{color:var(--ink,#0f0e0d);font-weight:600;}
    .shm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
    .shm-input{flex:1 1 140px;min-width:0;padding:10px 12px;border:1px solid var(--line,#e7e2d9);border-radius:9px;font-size:14px;font-family:inherit;background:#fff;color:var(--ink,#0f0e0d);}
    .shm-select{flex:0 1 auto;min-width:0;max-width:150px;padding:10px 8px;border:1px solid var(--line,#e7e2d9);border-radius:9px;font-size:13px;background:#fff;color:var(--ink,#0f0e0d);}
    .shm-row .shm-btn{flex:0 0 auto;}
    .shm-btn{padding:10px 16px;border:none;border-radius:9px;background:var(--accent,#2d7d4d);color:#fff;font-weight:600;font-size:14px;cursor:pointer;white-space:nowrap;}
    .shm-btn:disabled{opacity:.55;cursor:default;}
    .shm-btn.ghost{background:transparent;color:var(--ink,#0f0e0d);border:1px solid var(--line,#e7e2d9);}
    .shm-btn.danger{background:transparent;color:#b3261e;border:1px solid #e7c9c6;}
    .shm-linkbox{display:flex;gap:8px;align-items:center;margin-top:6px;}
    .shm-linkurl{flex:1;padding:10px 12px;border:1px solid var(--line,#e7e2d9);border-radius:9px;font:13px/1.3 'JetBrains Mono',ui-monospace,monospace;background:var(--wash,#f7f4ee);color:var(--ink,#0f0e0d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .shm-msg{font-size:12.5px;margin-top:10px;min-height:16px;color:var(--muted,#6b6459);}
    .shm-msg.err{color:#b3261e;}
    .shm-msg.ok{color:var(--accent,#2d7d4d);}
    .shm-list{margin-top:14px;border-top:1px solid var(--line,#e7e2d9);padding-top:10px;}
    .shm-li{display:flex;align-items:center;justify-content:space-between;padding:6px 0;font-size:13px;}
    .shm-li .who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .shm-li .rm{background:none;border:none;color:var(--muted,#8a8478);cursor:pointer;font-size:16px;padding:0 4px;}
    .shm-li .rm:hover{color:#b3261e;}
    .shm-foot{font-size:11.5px;color:var(--muted,#8a8478);margin-top:12px;}
    `;
    document.head.appendChild(s);
  }

  const SHARE_LEVELS = [
    ['can_use', 'Can use (their twin can read it)'],
    ['can_view', 'Can view'],
    ['can_comment', 'Can comment'],
    ['can_edit', 'Can edit'],
    ['full_access', 'Full access'],
  ];

  function whatBecomesVisible(resourceType, title) {
    const t = title ? `"${title}"` : 'this';
    if (resourceType === 'concept') return `Anyone with the link can read <b>${escapeHtml(t)}</b>, the page your twin compiled from your notes. Only this page is shared, nothing else in your twin.`;
    if (resourceType === 'answer') return `Anyone with the link can read this answer. Only this text is shared, nothing else in your twin.`;
    return `Anyone with the link can read <b>${escapeHtml(t)}</b>. Only this item is shared, nothing else in your twin.`;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ── Public-link panel ───────────────────────────────────────────────────────
  function buildLinkPanel(opts, body) {
    body.innerHTML = '';
    const note = el('p', 'shm-note'); note.innerHTML = whatBecomesVisible(opts.resourceType, opts.title);
    body.appendChild(note);
    const slot = el('div'); body.appendChild(slot);   // dynamic content
    const msg = el('div', 'shm-msg'); body.appendChild(msg);

    const linkEndpoint = opts.resourceType === 'item'
      ? `/api/items/${encodeURIComponent(opts.resourceId)}/public-link`
      : opts.resourceType === 'concept'
        ? `/api/concepts/${encodeURIComponent(opts.resourceId)}/public-link`
        : null; // answer handled specially
    let answerId = null;

    function renderActive(url) {
      slot.innerHTML = '';
      const box = el('div', 'shm-linkbox');
      const urlEl = el('div', 'shm-linkurl', url); urlEl.title = url;
      const copyBtn = el('button', 'shm-btn', 'Copy');
      copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(url); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1400); }
        catch (e) { const r = document.createRange(); r.selectNode(urlEl); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      };
      box.appendChild(urlEl); box.appendChild(copyBtn);
      slot.appendChild(box);
      const revoke = el('button', 'shm-btn danger', 'Stop sharing'); revoke.style.marginTop = '10px';
      revoke.onclick = async () => {
        revoke.disabled = true; msg.className = 'shm-msg'; msg.textContent = 'Revoking...';
        try {
          if (opts.resourceType === 'answer') await api('/api/answers/share', { method: 'DELETE', body: { answer_id: answerId } });
          else await api(linkEndpoint, { method: 'DELETE' });
          msg.className = 'shm-msg'; msg.textContent = '';
          renderCreate();
        } catch (e) { msg.className = 'shm-msg err'; msg.textContent = e.message; revoke.disabled = false; }
      };
      slot.appendChild(revoke);
    }

    function renderCreate() {
      slot.innerHTML = '';
      const btn = el('button', 'shm-btn', 'Create public link');
      btn.onclick = async () => {
        btn.disabled = true; msg.className = 'shm-msg'; msg.textContent = 'Creating link...';
        try {
          let resp;
          if (opts.resourceType === 'answer') {
            resp = await api('/api/answers/share', { method: 'POST', body: { title: opts.answer && opts.answer.title, content: opts.answer && opts.answer.content } });
            answerId = resp.answer_id;
          } else {
            resp = await api(linkEndpoint, { method: 'POST' });
          }
          msg.className = 'shm-msg ok'; msg.textContent = 'Link is live. Anyone with it can read this.';
          renderActive(resp.url);
        } catch (e) {
          btn.disabled = false; msg.className = 'shm-msg err';
          msg.textContent = e.status === 409 ? e.message : (e.status === 401 ? 'Sign in to create a public link.' : e.message);
        }
      };
      slot.appendChild(btn);
    }

    // Items + concepts: check for an existing active link first. Answers: always create.
    if (opts.resourceType === 'answer') { renderCreate(); }
    else {
      msg.textContent = 'Checking...';
      api(linkEndpoint).then(st => {
        msg.textContent = '';
        if (st && st.active && st.url) renderActive(st.url); else renderCreate();
      }).catch(() => { msg.textContent = ''; renderCreate(); });
    }
  }

  // ── Email-invite panel (items only) ─────────────────────────────────────────
  function buildEmailPanel(opts, body) {
    body.innerHTML = '';
    const note = el('p', 'shm-note'); note.innerHTML = 'Invite a specific person by email. They get access to <b>just this item</b>, at the level you choose.';
    body.appendChild(note);
    const row = el('div', 'shm-row');
    const input = el('input', 'shm-input'); input.type = 'email'; input.placeholder = 'name@email.com';
    const sel = el('select', 'shm-select'); SHARE_LEVELS.forEach(([v, l]) => { const o = el('option', null, l); o.value = v; sel.appendChild(o); });
    const send = el('button', 'shm-btn', 'Send');
    row.appendChild(input); row.appendChild(sel); row.appendChild(send);
    body.appendChild(row);
    const msg = el('div', 'shm-msg'); body.appendChild(msg);
    const list = el('div', 'shm-list'); body.appendChild(list);

    async function refresh() {
      try {
        const r = await api(`/api/items/${encodeURIComponent(opts.resourceId)}/permissions`);
        list.innerHTML = '';
        const rows = [...(r.grants || []).map(g => ({ who: g.email || g.user_id, id: g.id, kind: 'granted' })),
                      ...(r.pending || []).map(p => ({ who: p.email + ' (pending)', id: p.id, kind: 'invited' }))];
        if (!rows.length) { list.style.display = 'none'; return; }
        list.style.display = 'block';
        rows.forEach(x => {
          const li = el('div', 'shm-li');
          li.appendChild(el('span', 'who', x.who));
          const rm = el('button', 'rm', '×'); rm.title = 'Remove access';
          rm.onclick = async () => { try { await api(`/api/items/${encodeURIComponent(opts.resourceId)}/permissions/${x.id}`, { method: 'DELETE' }); refresh(); } catch (e) { msg.className = 'shm-msg err'; msg.textContent = e.message; } };
          li.appendChild(rm); list.appendChild(li);
        });
      } catch (e) {
        if (e.status === 403) { row.style.display = 'none'; msg.className = 'shm-msg'; msg.textContent = 'Only the owner can manage sharing.'; }
      }
    }
    send.onclick = async () => {
      const email = input.value.trim(); if (!email) { input.focus(); return; }
      send.disabled = true; msg.className = 'shm-msg'; msg.textContent = 'Sending...';
      try {
        const r = await api(`/api/items/${encodeURIComponent(opts.resourceId)}/share`, { method: 'POST', body: { email, level: sel.value } });
        msg.className = 'shm-msg ok'; msg.textContent = r.mode === 'invited' ? 'Invitation sent.' : 'Shared.';
        input.value = ''; refresh();
      } catch (e) { msg.className = 'shm-msg err'; msg.textContent = e.status === 401 ? 'Sign in to share by email.' : e.message; }
      finally { send.disabled = false; }
    };
    refresh();
  }

  function openShareModal(opts) {
    ensureStyles();
    const modes = opts.modes || (opts.resourceType === 'item' ? ['email', 'link'] : ['link']);

    const overlay = el('div', 'shm-overlay');
    const prevFocus = document.activeElement;                 // A3: restore on close
    const card = el('div', 'shm-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'shm-dialog-title');
    card.tabIndex = -1;
    const head = el('div', 'shm-head');
    const titleEl = el('h3', 'shm-title', 'Share'); titleEl.id = 'shm-dialog-title';
    head.appendChild(titleEl);
    const x = el('button', 'shm-x', '×'); x.setAttribute('aria-label', 'Close dialog');
    head.appendChild(x);
    card.appendChild(head);

    const body = el('div', 'shm-body');
    const tabs = el('div', 'shm-tabs');

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();    // A3: restore focus to trigger
    }
    function focusables() {
      return [...card.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
        .filter(e => e.offsetParent !== null);
    }
    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'Tab') {                                   // A3: trap focus inside the dialog
        const f = focusables(); if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    x.onclick = close;
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);

    function show(mode) {
      tabs.querySelectorAll('.shm-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
      if (mode === 'email') buildEmailPanel(opts, body); else buildLinkPanel(opts, body);
    }

    if (modes.length > 1) {
      modes.forEach(m => {
        const tab = el('button', 'shm-tab', m === 'email' ? 'Invite by email' : 'Public link');
        tab.dataset.mode = m; tab.onclick = () => show(m);
        tabs.appendChild(tab);
      });
      card.appendChild(tabs);
    }
    card.appendChild(body);

    const foot = el('div', 'shm-foot', 'Private by default. You can stop sharing at any time.');
    foot.style.padding = '0 20px 18px';
    card.appendChild(foot);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    show(modes[0]);
    (focusables()[0] || card).focus();                        // A3: move focus into the dialog
  }

  window.LutoShare = { open: openShareModal };
})();
