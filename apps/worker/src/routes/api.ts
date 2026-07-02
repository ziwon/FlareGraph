import { Hono } from 'hono';
import type { SearchMode } from '@flaregraph/contracts';
import { getPageByPath, keywordSearch, safeJsonArray } from '@flaregraph/db';
import type { Env } from '../env.js';
import { D1Exec } from '../d1.js';
import { search } from '../search/hybrid.js';
import { captureNote, findClaims, listLinksFor, neighborsForPath, readNote } from '../handlers.js';
import { compileWikiPage, extractGraph } from '../compiler.js';
import { rebuildFromMirror } from '../indexer/index.js';

type Ctx = { Bindings: Env; Variables: { exec: D1Exec; subject: string } };

export const api = new Hono<Ctx>();

api.get('/health', async (c) => {
  const exec = c.get('exec');
  const rows = await exec.all<{ n: number; last: string | null }>(
    'SELECT COUNT(*) AS n, MAX(indexed_at) AS last FROM pages WHERE deleted_at IS NULL',
  );
  return c.json({ ok: true, version: '0.1.0', pages: rows[0]?.n ?? 0, lastIndexedAt: rows[0]?.last ?? null });
});

api.get('/pages', async (c) => {
  const exec = c.get('exec');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 10000);
  const rows = await exec.all<Record<string, unknown>>(
    'SELECT id, path, title, aliases, tags, tier, checksum, indexed_at, updated_at FROM pages WHERE deleted_at IS NULL ORDER BY path LIMIT ?',
    [limit],
  );
  return c.json({
    pages: rows.map((r) => ({ ...r, aliases: safeJsonArray(r.aliases as string), tags: safeJsonArray(r.tags as string) })),
  });
});

api.get('/pages/:id', async (c) => {
  const exec = c.get('exec');
  const rows = await exec.all<{ path: string }>('SELECT path FROM pages WHERE id = ? AND deleted_at IS NULL', [
    c.req.param('id'),
  ]);
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  const page = await getPageByPath(exec, row.path);
  const links = await listLinksFor(exec, row.path);
  const headings = await exec.all('SELECT level, title, slug FROM headings WHERE page_id = ? ORDER BY position', [
    c.req.param('id'),
  ]);
  return c.json({ ...page, headings, ...links });
});

api.get('/search', async (c) => {
  const exec = c.get('exec');
  const q = c.req.query('q') ?? '';
  if (!q.trim()) return c.json({ error: 'q required' }, 400);
  const mode = (c.req.query('mode') ?? 'hybrid') as SearchMode;
  const res = await search(c.env, exec, q, {
    mode,
    limit: parseInt(c.req.query('limit') ?? '10', 10),
    includeCompiled: c.req.query('include_compiled') === 'true',
  });
  return c.json(res);
});

api.get('/notes/*', async (c) => {
  const path = decodeURIComponent(c.req.path.replace(/^\/api\/notes\//, ''));
  const note = await readNote(c.env, c.get('exec'), path);
  if (!note) return c.text('not found', 404);
  return c.text(note.content, 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'X-Indexed-At': note.indexedAt ?? 'never',
  });
});

api.get('/graph/neighbors/:id', async (c) => {
  const exec = c.get('exec');
  const rows = await exec.all<{ path: string }>('SELECT path FROM pages WHERE id = ? AND deleted_at IS NULL', [
    c.req.param('id'),
  ]);
  const row = rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  const hops = Math.min(parseInt(c.req.query('hops') ?? '1', 10), 2);
  const neighbors = await neighborsForPath(exec, row.path, hops, parseInt(c.req.query('limit') ?? '20', 10));
  return c.json({ neighbors });
});

api.get('/claims', async (c) => {
  const q = c.req.query('q') ?? '';
  return c.json({ claims: await findClaims(c.get('exec'), q, parseInt(c.req.query('limit') ?? '20', 10)) });
});

api.post('/capture', async (c) => {
  const body = (await c.req.json()) as { content?: string; title?: string; tags?: string[] };
  if (!body.content?.trim()) return c.json({ error: 'content required' }, 400);
  const result = await captureNote(c.env, c.get('exec'), {
    content: body.content,
    title: body.title,
    tags: body.tags,
    source: 'api',
    tool: 'capture',
  });
  return c.json(result, 201);
});

api.post('/index/push', async (c) => {
  // plugin checksum push (planning §5.1): {path, checksum}, body never sent
  const body = (await c.req.json()) as { path?: string; checksum?: string; deleted?: boolean };
  if (!body.path) return c.json({ error: 'path required' }, 400);
  await c.env.INDEX_QUEUE.send(
    body.deleted
      ? { kind: 'r2-event', key: body.path, action: 'DeleteObject' }
      : { kind: 'push', key: body.path, checksum: body.checksum },
  );
  return c.json({ queued: true });
});

api.post('/index/rebuild', async (c) => {
  const result = await rebuildFromMirror(c.env, c.get('exec'));
  return c.json(result);
});

api.post('/wiki/compile', async (c) => {
  const body = (await c.req.json()) as { topic?: string; category?: string; maxSources?: number };
  if (!body.topic?.trim()) return c.json({ error: 'topic required' }, 400);
  const result = await compileWikiPage(c.env, c.get('exec'), body.topic, body.category ?? 'Concepts', body.maxSources ?? 5);
  return c.json(result, 201);
});

api.post('/graph/extract', async (c) => {
  const body = (await c.req.json()) as { path?: string };
  if (!body.path) return c.json({ error: 'path required' }, 400);
  return c.json(await extractGraph(c.env, c.get('exec'), body.path));
});

api.get('/errors', async (c) => {
  const rows = await c
    .get('exec')
    .all("SELECT type, message, status, occurrence_count, created_at FROM error_book WHERE status != 'resolved' ORDER BY occurrence_count DESC LIMIT 100");
  return c.json({ errors: rows });
});

api.get('/rules', async (c) => {
  const rows = await c.get('exec').all('SELECT rule, active, created_at FROM compiler_rules ORDER BY created_at DESC LIMIT 100');
  return c.json({ rules: rows });
});

api.get('/search/keyword-only', async (c) => {
  // debugging aid: pure FTS/metadata axis without AI calls
  const q = c.req.query('q') ?? '';
  return c.json(await keywordSearch(c.get('exec'), q, { limit: 20 }));
});
