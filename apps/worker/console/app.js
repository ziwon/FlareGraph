/* FlareGraph console — vanilla JS, no dependencies. */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { mode: 'hybrid', hits: [], activePath: null };

  $('host').textContent = location.host;

  // ── auth: Access cookie just works; otherwise a Bearer token is kept locally
  const tokenKey = 'flaregraph_token';
  const getToken = () => localStorage.getItem(tokenKey) || '';
  const headers = () => (getToken() ? { Authorization: `Bearer ${getToken()}` } : {});

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
    if (res.status === 401) {
      askToken();
      throw new Error('unauthorized');
    }
    return res;
  }

  function askToken() {
    const dlg = $('tokendlg');
    if (!dlg.open) dlg.showModal();
  }
  $('token-save').addEventListener('click', () => {
    localStorage.setItem(tokenKey, $('token-input').value.trim());
    $('tokendlg').close();
    loadHealth();
    run();
  });
  $('token-cancel').addEventListener('click', () => $('tokendlg').close());

  // ── health strip
  async function loadHealth() {
    try {
      const res = await api('/api/health');
      const h = await res.json();
      $('stat-pages').textContent = h.pages;
      $('stat-indexed').textContent = h.lastIndexedAt ? relTime(h.lastIndexedAt) : 'never';
      $('health-dot').classList.toggle('err', !h.ok);
    } catch {
      $('health-dot').classList.add('err');
    }
  }
  function relTime(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  // ── search
  let timer;
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
  $('compiled').addEventListener('change', run);
  $('modes').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    for (const b of $('modes').children) b.classList.toggle('on', b === btn);
    run();
  });

  async function run() {
    const q = $('q').value.trim();
    const box = $('results');
    if (!q) { box.innerHTML = '<div class="empty">Type to search.</div>'; return; }
    box.innerHTML = '<div class="spin">searching…</div>';
    try {
      const params = new URLSearchParams({ q, mode: state.mode, include_compiled: $('compiled').checked });
      const res = await api(`/api/search?${params}`);
      if (!res.ok) { box.innerHTML = `<div class="empty">search failed (${res.status})</div>`; return; }
      const data = await res.json();
      state.hits = data.hits;
      render();
    } catch (err) {
      if (err.message !== 'unauthorized') box.innerHTML = '<div class="empty">network error</div>';
    }
  }

  function render() {
    const box = $('results');
    if (state.hits.length === 0) { box.innerHTML = '<div class="empty">No results.</div>'; return; }
    box.innerHTML = '';
    for (const h of state.hits) {
      const el = document.createElement('button');
      el.className = 'hit' + (h.path === state.activePath ? ' on' : '');
      el.innerHTML = `
        <div class="row1">
          <span class="title">${esc(h.title)}</span>
          ${h.tier !== 'raw' ? `<span class="badge ${h.tier}">${h.tier}</span>` : ''}
          <span class="badge ${h.matchType === 'semantic' || h.matchType === 'graph' ? h.matchType : ''}">${h.matchType}</span>
        </div>
        <div class="path">${esc(h.path)}${h.heading ? ` › ${esc(h.heading)}` : ''}</div>
        ${h.snippet ? `<div class="snippet">${snippet(h.snippet)}</div>` : ''}`;
      el.addEventListener('click', () => openNote(h.path));
      box.appendChild(el);
    }
  }

  // ── reader
  $('rclose').addEventListener('click', () => {
    $('reader').classList.remove('open');
    state.activePath = null;
    render();
  });

  async function openNote(path) {
    state.activePath = path;
    render();
    const reader = $('reader');
    reader.classList.add('open');
    $('rpath').textContent = path;
    $('rmd').innerHTML = '<div class="spin">loading…</div>';
    $('rlinks').hidden = true;
    try {
      const res = await api(`/api/notes/${encodeURI(path)}`);
      if (!res.ok) { $('rmd').textContent = `failed to read note (${res.status})`; return; }
      $('rmd').innerHTML = renderMd(await res.text());
      bindWikilinks();
      reader.scrollIntoView({ behavior: 'smooth', block: 'start' });
      loadLinks(path);
    } catch { /* dialog already shown on 401 */ }
  }

  async function loadLinks(path) {
    try {
      const pages = await (await api('/api/pages?limit=10000')).json();
      const page = pages.pages.find((p) => p.path === path);
      if (!page) return;
      const detail = await (await api(`/api/pages/${page.id}`)).json();
      const out = (detail.outgoing || []).filter((l) => l.linkType !== 'url');
      const back = detail.backlinks || [];
      if (out.length === 0 && back.length === 0) return;
      const box = $('rlinks');
      box.innerHTML =
        (out.length ? `<div class="lbl">Links</div><div class="chips">${out.map(chip).join('')}</div>` : '') +
        (back.length ? `<div class="lbl">Backlinks</div><div class="chips">${back.map((l) => chipPath(l.srcPath)).join('')}</div>` : '');
      box.hidden = false;
      for (const c of box.querySelectorAll('.chip[data-path]')) {
        c.addEventListener('click', () => openNote(c.dataset.path));
      }
    } catch { /* links are optional */ }
  }
  const chip = (l) => l.resolved && l.dstPath
    ? chipPath(l.dstPath)
    : `<span class="chip dangling" title="dangling link">${esc(l.rawTarget)}</span>`;
  const chipPath = (p) => `<span class="chip" data-path="${esc(p)}">${esc(p.split('/').pop().replace(/\.md$/i, ''))}</span>`;

  function bindWikilinks() {
    for (const w of $('rmd').querySelectorAll('.wikilink')) {
      w.addEventListener('click', () => {
        $('q').value = w.dataset.target;
        run();
      });
    }
  }

  // ── tiny markdown renderer (headings, fences, lists, quotes, inline marks)
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function snippet(s) {
    return esc(s).replace(/&lt;&lt;(.+?)&gt;&gt;/g, '<mark>$1</mark>');
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/!?\[\[([^\][|#]+)(?:#[^\][|]*)?(?:\|([^\][]+))?\]\]/g,
        (_, t, alias) => `<span class="wikilink" data-target="${esc(t.trim())}">${esc((alias || t).trim())}</span>`)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  }
  function renderMd(src) {
    let text = src;
    let fm = '';
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (m) { fm = `<div class="fm">${esc(m[1])}</div>`; text = text.slice(m[0].length); }
    const lines = text.split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'
    let inFence = false;
    let fenceBuf = [];
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of lines) {
      if (inFence) {
        if (/^(```|~~~)/.test(line.trim())) { out.push(`<pre><code>${esc(fenceBuf.join('\n'))}</code></pre>`); inFence = false; fenceBuf = []; }
        else fenceBuf.push(line);
        continue;
      }
      if (/^(```|~~~)/.test(line.trim())) { closeList(); inFence = true; continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { closeList(); out.push(`<h${Math.min(h[1].length, 4)}>${inline(h[2])}</h${Math.min(h[1].length, 4)}>`); continue; }
      if (/^\s*([-*+])\s+/.test(line)) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`); continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`); continue;
      }
      closeList();
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); continue; }
      if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
      if (line.trim() === '') continue;
      out.push(`<p>${inline(line)}</p>`);
    }
    if (inFence) out.push(`<pre><code>${esc(fenceBuf.join('\n'))}</code></pre>`);
    closeList();
    return fm + out.join('\n');
  }

  loadHealth();
})();
