/** Minimal search UI served at / for humans logged in via Cloudflare Access. */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlareGraph</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 780px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h1 span { color: #f6821f; }
  input[type=search] { width: 100%; padding: .6rem .8rem; font-size: 1rem; border: 1px solid #8884; border-radius: 8px; }
  .hit { padding: .6rem 0; border-bottom: 1px solid #8883; }
  .hit a { font-weight: 600; text-decoration: none; cursor: pointer; }
  .meta { font-size: .8rem; opacity: .7; }
  .snippet { font-size: .9rem; opacity: .85; }
  pre#note { white-space: pre-wrap; background: #8881; padding: 1rem; border-radius: 8px; }
  label { font-size: .85rem; margin-left: .5rem; }
</style>
</head>
<body>
<h1><span>◆</span> FlareGraph <span class="meta">— Obsidian vault search</span></h1>
<input type="search" id="q" placeholder="Search notes… (keyword + semantic + graph)" autofocus>
<label><input type="checkbox" id="compiled"> include Wiki/ pages</label>
<div id="results"></div>
<pre id="note" hidden></pre>
<script>
const q = document.getElementById('q'), results = document.getElementById('results'), note = document.getElementById('note');
let t;
q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 300); });
document.getElementById('compiled').addEventListener('change', run);
async function run() {
  note.hidden = true;
  if (!q.value.trim()) { results.innerHTML = ''; return; }
  const inc = document.getElementById('compiled').checked;
  const res = await fetch('/api/search?q=' + encodeURIComponent(q.value) + '&mode=hybrid&include_compiled=' + inc);
  if (!res.ok) { results.textContent = 'search failed: ' + res.status; return; }
  const data = await res.json();
  results.innerHTML = data.hits.map(h =>
    '<div class="hit"><a data-path="' + encodeURIComponent(h.path) + '">' + esc(h.title) + '</a>' +
    ' <span class="meta">' + esc(h.path) + ' · ' + h.matchType + ' · ' + h.score.toFixed(1) + '</span>' +
    (h.snippet ? '<div class="snippet">' + esc(h.snippet) + '</div>' : '') + '</div>').join('') || 'no results';
  results.querySelectorAll('a').forEach(a => a.addEventListener('click', async () => {
    const r = await fetch('/api/notes/' + a.dataset.path);
    note.textContent = r.ok ? await r.text() : 'failed to read note';
    note.hidden = false; note.scrollIntoView({behavior: 'smooth'});
  }));
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
</script>
</body>
</html>`;
