/* FlareGraph console — vanilla JS, no dependencies. */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    mode: 'hybrid',
    view: 'home', // 'home' | 'search'
    items: [], // entries backing the list: search hits or recent pages
    recent: null, // cached recent pages for the home view
    activePath: null, // note open in the reader
    sel: -1, // keyboard selection index into state.items
    emptyMsg: '',
  };

  $('host').textContent = location.host;

  // ── theme: the inline <head> script applied the initial value before paint
  $('themebtn').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.classList.add('notransition'); // flip every surface in the same frame
    root.dataset.theme = next;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('notransition')));
    try {
      localStorage.setItem('flaregraph_theme', next);
    } catch {
      /* private mode: theme just won't persist */
    }
  });

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
    state.recent = null;
    loadHealth();
    refresh();
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

  // ── query input, modes
  let timer;
  $('q').addEventListener('input', () => {
    $('q')
      .closest('.searchbox')
      .classList.toggle('filled', $('q').value !== '');
    clearTimeout(timer);
    timer = setTimeout(refresh, 280);
  });
  $('compiled').addEventListener('change', refresh);
  $('modes').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    for (const b of $('modes').children) b.classList.toggle('on', b === btn);
    refresh();
  });

  function refresh() {
    if ($('q').value.trim()) run();
    else loadHome();
  }

  const setLabel = (text) => {
    $('listlabel').textContent = text;
  };
  const skeleton = () => {
    state.items = [];
    $('results').innerHTML = '<div class="skel"></div>'.repeat(3);
  };
  const empty = (title, hint) => `<div class="empty"><b>${esc(title)}</b>${esc(hint || '')}</div>`;

  // ── home: recent notes, so the console is useful before the first query
  async function loadHome() {
    state.view = 'home';
    state.sel = -1;
    setLabel('recently updated');
    if (state.recent) {
      state.items = state.recent;
      renderList();
    } else skeleton();
    try {
      const res = await api('/api/pages?sort=recent&limit=24');
      if (!res.ok) throw new Error(`pages ${res.status}`);
      const data = await res.json();
      const recent = data.pages.map((p) => ({
        kind: 'page',
        path: p.path,
        title: p.title,
        tier: p.tier,
        updated: p.updated_at || p.indexed_at,
        tags: p.tags || [],
      }));
      state.recent = recent;
      if (state.view !== 'home') return; // a search started meanwhile
      state.items = recent;
      renderList(
        empty(
          'No notes indexed yet',
          'Sync the vault with remotely-save, or capture a note via the API or MCP.',
        ),
      );
    } catch (err) {
      if (state.view !== 'home') return;
      state.items = [];
      renderList(
        err.message === 'unauthorized'
          ? empty('Authentication required', 'Log in via Cloudflare Access or save an API token.')
          : empty(
              'API unreachable',
              'Browsing and search need the worker; this is only the static shell.',
            ),
      );
    }
  }

  // ── search
  async function run() {
    const q = $('q').value.trim();
    state.view = 'search';
    state.sel = -1;
    setLabel('searching');
    skeleton();
    try {
      const params = new URLSearchParams({
        q,
        mode: state.mode,
        include_compiled: $('compiled').checked,
      });
      const res = await api(`/api/search?${params}`);
      if ($('q').value.trim() !== q) return; // stale response
      if (!res.ok) {
        setLabel('results');
        state.items = [];
        renderList(empty(`Search failed (${res.status})`, 'Check the worker logs.'));
        return;
      }
      const data = await res.json();
      state.items = data.hits.map((h) => ({ kind: 'hit', ...h }));
      setLabel(`results · ${state.items.length}`);
      renderList(empty(`No results for “${q}”`, 'Try semantic mode, or include Wiki/ pages.'));
    } catch (err) {
      if (err.message === 'unauthorized') return;
      state.items = [];
      setLabel('results');
      renderList(empty('Network error', 'The worker did not answer.'));
    }
  }

  // ── result list (shared by home and search)
  function renderList(emptyMsg) {
    if (emptyMsg !== undefined) state.emptyMsg = emptyMsg;
    const box = $('results');
    if (!state.items.length) {
      box.innerHTML = state.emptyMsg;
      return;
    }
    box.innerHTML = '';
    state.items.forEach((it, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `hit${it.path === state.activePath ? ' on' : ''}${i === state.sel ? ' sel' : ''}`;
      el.innerHTML = itemHtml(it);
      el.addEventListener('click', () => openNote(it.path));
      box.appendChild(el);
    });
  }

  const badge = (cls, txt) => `<span class="badge ${cls}">${esc(txt)}</span>`;
  function itemHtml(h) {
    if (h.kind === 'hit') {
      return `
      <div class="row1">
        <span class="title">${esc(h.title)}</span>
        ${h.tier !== 'raw' ? badge(h.tier, h.tier) : ''}
        ${badge(h.matchType === 'semantic' || h.matchType === 'graph' ? h.matchType : '', h.matchType)}
      </div>
      <div class="path">${esc(disp(h.path))}${h.heading ? ` › ${esc(h.heading)}` : ''}</div>
      ${h.snippet ? `<div class="snippet">${snippet(h.snippet)}</div>` : ''}`;
    }
    const tags = (h.tags || [])
      .slice(0, 4)
      .map((t) => `<span class="tag" data-tag="${esc(t)}">#${esc(t)}</span>`)
      .join('');
    return `
      <div class="row1">
        <span class="title">${esc(h.title)}</span>
        ${h.tier !== 'raw' ? badge(h.tier, h.tier) : ''}
        ${h.updated ? `<span class="time">${relTime(h.updated)}</span>` : ''}
      </div>
      <div class="path">${esc(disp(h.path))}</div>
      ${tags ? `<div class="tags">${tags}</div>` : ''}`;
  }

  // tag chips search for that tag; capture phase so the card click doesn't fire
  $('results').addEventListener(
    'click',
    (e) => {
      const tag = e.target.closest('.tag');
      if (!tag) return;
      e.stopPropagation();
      $('q').value = tag.dataset.tag;
      $('q').closest('.searchbox').classList.add('filled');
      run();
    },
    true,
  );

  // ── keyboard: ⌘K or / focus search, ↑/↓ select, Enter open, Esc close/clear
  $('kbdhint').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  document.addEventListener('keydown', (e) => {
    if ($('tokendlg').open) return;
    const inField = e.target instanceof HTMLElement && e.target.matches('input, textarea');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('q').focus();
      $('q').select();
      return;
    }
    if (e.key === '/' && !inField) {
      e.preventDefault();
      $('q').focus();
      return;
    }
    if (e.key === 'Escape') {
      if ($('reader').classList.contains('open')) {
        e.preventDefault(); // keep the browser from also clearing the search input
        closeReader();
      } else if ($('q').value) {
        e.preventDefault();
        $('q').value = '';
        $('q').closest('.searchbox').classList.remove('filled');
        refresh();
      }
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.items.length) {
      if (inField && e.target.id !== 'q') return;
      e.preventDefault();
      state.sel =
        e.key === 'ArrowDown'
          ? Math.min(state.sel + 1, state.items.length - 1)
          : Math.max(state.sel - 1, 0);
      syncSel();
      return;
    }
    if (e.key === 'Enter' && state.sel >= 0 && (!inField || e.target.id === 'q')) {
      const it = state.items[state.sel];
      if (it) openNote(it.path);
    }
  });
  function syncSel() {
    for (const [i, el] of [...$('results').children].entries()) {
      el.classList.toggle('sel', i === state.sel);
    }
    $('results').children[state.sel]?.scrollIntoView({ block: 'nearest' });
  }
  function syncActive() {
    for (const [i, el] of [...$('results').children].entries()) {
      el.classList.toggle('on', state.items[i]?.path === state.activePath);
    }
  }

  // ── reader
  $('rclose').addEventListener('click', closeReader);
  const cols = document.querySelector('.cols');
  function closeReader() {
    $('reader').classList.remove('open');
    cols.classList.remove('reading');
    state.activePath = null;
    syncActive();
  }

  async function openNote(path) {
    state.activePath = path;
    syncActive();
    $('reader').classList.add('open');
    cols.classList.add('reading');
    $('rpath').textContent = disp(path);
    $('rmd').innerHTML = '<div class="skel"></div><div class="skel short"></div>';
    $('rlinks').hidden = true;
    try {
      const notePath = path.split('/').map(encodeURIComponent).join('/');
      const res = await api(`/api/notes/${notePath}`);
      if (state.activePath !== path) return; // another note opened meanwhile
      if (!res.ok) {
        $('rmd').textContent = `failed to read note (${res.status})`;
        return;
      }
      $('rmd').innerHTML = renderMd(await res.text());
      bindWikilinks();
      $('rmd').closest('.rbody').scrollTop = 0;
      loadLinks(path);
    } catch {
      /* dialog already shown on 401 */
    }
  }

  async function loadLinks(path) {
    try {
      const res = await api(`/api/pages?path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const page = (await res.json()).pages[0];
      if (!page || state.activePath !== path) return;
      const detail = await (await api(`/api/pages/${page.id}`)).json();
      const out = (detail.outgoing || []).filter((l) => l.linkType !== 'url');
      const back = detail.backlinks || [];
      if (out.length === 0 && back.length === 0) return;
      const box = $('rlinks');
      box.innerHTML =
        (out.length
          ? `<div class="lbl">Links</div><div class="chips">${out.map(chip).join('')}</div>`
          : '') +
        (back.length
          ? `<div class="lbl">Backlinks</div><div class="chips">${back.map((l) => chipPath(l.srcPath)).join('')}</div>`
          : '');
      box.hidden = false;
      for (const c of box.querySelectorAll('.chip[data-path]')) {
        c.addEventListener('click', () => openNote(c.dataset.path));
      }
    } catch {
      /* links are optional */
    }
  }
  const chip = (l) =>
    l.resolved && l.dstPath
      ? chipPath(l.dstPath)
      : `<span class="chip dangling" title="dangling link">${esc(l.rawTarget)}</span>`;
  const chipPath = (p) =>
    `<span class="chip" data-path="${esc(p)}">${esc(
      disp(p).split('/').pop().replace(/\.md$/i, ''),
    )}</span>`;

  function bindWikilinks() {
    for (const w of $('rmd').querySelectorAll('.wikilink')) {
      w.addEventListener('click', () => {
        $('q').value = w.dataset.target;
        $('q').closest('.searchbox').classList.add('filled');
        run();
      });
    }
  }

  /** Display form of a vault path: percent-encoded R2 keys stay fetchable
   *  as-is, but humans should read the decoded text. */
  function disp(p) {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  }

  // ── tiny markdown renderer (headings, fences, lists, tasks, tables, quotes)
  function esc(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  }
  function snippet(s) {
    return esc(s).replace(/&lt;&lt;(.+?)&gt;&gt;/g, '<mark>$1</mark>');
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(
        /!?\[\[([^\][|#]+)(?:#[^\][|]*)?(?:\|([^\][]+))?\]\]/g,
        (_, t, alias) =>
          `<span class="wikilink" data-target="${esc(t.trim())}">${esc((alias || t).trim())}</span>`,
      )
      .replace(
        /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  }
  function renderMd(src) {
    let text = src;
    let fm = '';
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (m) {
      fm = `<div class="fm">${esc(m[1])}</div>`;
      text = text.slice(m[0].length);
    }
    const lines = text.split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'
    let inFence = false;
    let fenceBuf = [];
    let tableBuf = [];
    const closeList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };
    const cells = (row) =>
      row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => inline(c.trim()));
    const flushTable = () => {
      if (!tableBuf.length) return;
      const hasHead = tableBuf.length > 1 && /^\s*\|?[\s:|-]+\|?\s*$/.test(tableBuf[1]);
      const head = hasHead ? cells(tableBuf[0]) : null;
      const rows = (hasHead ? tableBuf.slice(2) : tableBuf).map(cells);
      out.push('<div class="tbl"><table>');
      if (head) out.push(`<thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`);
      out.push(
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`,
      );
      out.push('</table></div>');
      tableBuf = [];
    };
    for (const line of lines) {
      if (inFence) {
        if (/^(```|~~~)/.test(line.trim())) {
          out.push(`<pre><code>${esc(fenceBuf.join('\n'))}</code></pre>`);
          inFence = false;
          fenceBuf = [];
        } else fenceBuf.push(line);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        closeList();
        tableBuf.push(line);
        continue;
      }
      flushTable();
      if (/^(```|~~~)/.test(line.trim())) {
        closeList();
        inFence = true;
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        closeList();
        const lvl = Math.min(h[1].length, 4);
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        continue;
      }
      const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
      if (task) {
        if (list !== 'ul') {
          closeList();
          out.push('<ul>');
          list = 'ul';
        }
        const done = task[1] !== ' ';
        out.push(
          `<li class="task"><input type="checkbox" disabled${done ? ' checked' : ''}><span${done ? ' class="done"' : ''}>${inline(task[2])}</span></li>`,
        );
        continue;
      }
      if (/^\s*([-*+])\s+/.test(line)) {
        if (list !== 'ul') {
          closeList();
          out.push('<ul>');
          list = 'ul';
        }
        out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        if (list !== 'ol') {
          closeList();
          out.push('<ol>');
          list = 'ol';
        }
        out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
        continue;
      }
      closeList();
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
        out.push('<hr>');
        continue;
      }
      if (/^>\s?/.test(line)) {
        out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
        continue;
      }
      if (line.trim() === '') continue;
      out.push(`<p>${inline(line)}</p>`);
    }
    if (inFence) out.push(`<pre><code>${esc(fenceBuf.join('\n'))}</code></pre>`);
    flushTable();
    closeList();
    return fm + out.join('\n');
  }

  loadHealth();
  refresh();
})();
