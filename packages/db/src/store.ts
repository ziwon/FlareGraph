import type { IndexedNote } from '@flaregraph/core';
import { LinkResolver, newId, type PageRef } from '@flaregraph/core';
import type { SqlExec } from './exec.js';
import { splitStatements } from './exec.js';

export async function applyMigrations(
  exec: SqlExec,
  migrations: { name: string; sql: string }[],
): Promise<void> {
  await exec.run(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    (await exec.all<{ name: string }>('SELECT name FROM _migrations')).map((r) => r.name),
  );
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    for (const stmt of splitStatements(m.sql)) await exec.run(stmt);
    await exec.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [
      m.name,
      new Date().toISOString(),
    ]);
  }
}

export interface PageRow {
  id: string;
  path: string;
  title: string;
  aliases: string | null;
  tags: string | null;
  tier: string;
  checksum: string;
  indexed_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}

export async function getPageByPath(exec: SqlExec, path: string): Promise<PageRow | undefined> {
  const rows = await exec.all<PageRow>('SELECT * FROM pages WHERE path = ? AND deleted_at IS NULL', [path]);
  return rows[0];
}

export async function getPageChecksum(exec: SqlExec, path: string): Promise<string | undefined> {
  const rows = await exec.all<{ checksum: string }>(
    'SELECT checksum FROM pages WHERE path = ? AND deleted_at IS NULL',
    [path],
  );
  return rows[0]?.checksum;
}

/** Persist one indexed note: page upsert + full replacement of derived rows.
 *  Preserves 'embedded' status for chunks whose content-addressed id survived. */
export async function savePage(exec: SqlExec, idx: IndexedNote, now: string): Promise<void> {
  const { page, headings, links, chunks } = idx;
  // A chunk counts as embedded if its row says so OR a live vector still exists
  // for its content-addressed id (rename case, ADR-010: no re-embedding).
  const embedded = new Set(
    (
      await exec.all<{ id: string }>(
        "SELECT id FROM chunks WHERE page_id = ? AND embedding_status = 'embedded'",
        [page.id],
      )
    ).map((r) => r.id),
  );
  for (const r of await exec.all<{ target_id: string }>(
    "SELECT target_id FROM vector_refs WHERE page_id = ? AND target_type = 'chunk'",
    [page.id],
  ))
    embedded.add(r.target_id);

  await exec.run(
    `INSERT INTO pages (id, path, title, aliases, tags, frontmatter, tier, checksum, created_at, updated_at, indexed_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path, title = excluded.title, aliases = excluded.aliases,
       tags = excluded.tags, frontmatter = excluded.frontmatter, tier = excluded.tier,
       checksum = excluded.checksum, updated_at = excluded.updated_at,
       indexed_at = excluded.indexed_at, deleted_at = NULL`,
    [
      page.id,
      page.path,
      page.title,
      JSON.stringify(page.aliases),
      JSON.stringify(page.tags),
      JSON.stringify(page.frontmatter),
      page.tier,
      page.checksum,
      page.createdAt ?? now,
      page.updatedAt ?? now,
      now,
    ],
  );

  await exec.run('DELETE FROM headings WHERE page_id = ?', [page.id]);
  for (const h of headings) {
    await exec.run(
      'INSERT INTO headings (id, page_id, level, title, slug, position) VALUES (?, ?, ?, ?, ?, ?)',
      [h.id, h.pageId, h.level, h.title, h.slug, h.position],
    );
  }

  await exec.run('DELETE FROM links WHERE src_page_id = ?', [page.id]);
  for (const l of links) {
    await exec.run(
      `INSERT INTO links (id, src_page_id, dst_page_id, raw_target, link_type, anchor_text, position, resolved)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 0)`,
      [l.id, l.srcPageId, l.rawTarget, l.linkType, l.anchorText ?? null, l.position],
    );
  }

  await exec.run('DELETE FROM chunks WHERE page_id = ?', [page.id]);
  await exec.run('DELETE FROM chunks_fts WHERE page_id = ?', [page.id]);
  for (const c of chunks) {
    const status = !c.embeddable ? 'excluded' : embedded.has(c.id) ? 'embedded' : 'pending';
    await exec.run(
      `INSERT INTO chunks (id, page_id, chunk_index, heading_id, text_hash, token_count, start_offset, end_offset, embedding_status, embedded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.id,
        c.pageId,
        c.index,
        c.headingSlug ?? null,
        c.hash,
        c.tokenCount,
        c.startOffset,
        c.endOffset,
        status,
        status === 'embedded' ? now : null,
      ],
    );
    await exec.run(
      'INSERT INTO chunks_fts (chunk_id, page_id, heading, body) VALUES (?, ?, ?, ?)',
      [c.id, c.pageId, c.headingSlug ?? '', c.text],
    );
  }
}

/** Soft-delete a page and remove its derived rows (FTS immediately, vectors via GC). */
export async function deletePage(exec: SqlExec, path: string, now: string): Promise<string | undefined> {
  const page = await getPageByPath(exec, path);
  if (!page) return undefined;
  await exec.run('UPDATE pages SET deleted_at = ? WHERE id = ?', [now, page.id]);
  await exec.run('DELETE FROM headings WHERE page_id = ?', [page.id]);
  await exec.run('DELETE FROM links WHERE src_page_id = ?', [page.id]);
  await exec.run('UPDATE links SET dst_page_id = NULL, resolved = 0 WHERE dst_page_id = ?', [page.id]);
  await exec.run('DELETE FROM chunks WHERE page_id = ?', [page.id]);
  await exec.run('DELETE FROM chunks_fts WHERE page_id = ?', [page.id]);
  return page.id;
}

/** ADR-010 rename: same checksum, new path → metadata-only update, vectors kept. */
export async function findPageByChecksum(
  exec: SqlExec,
  checksum: string,
): Promise<PageRow | undefined> {
  const rows = await exec.all<PageRow>(
    'SELECT * FROM pages WHERE checksum = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1',
    [checksum],
  );
  return rows[0];
}

/** Global link resolution pass: fills dst_page_id using path/title/alias matching. */
export async function resolveAllLinks(exec: SqlExec): Promise<{ resolved: number; dangling: number }> {
  const pages = await exec.all<{ id: string; path: string; title: string; aliases: string | null }>(
    'SELECT id, path, title, aliases FROM pages WHERE deleted_at IS NULL',
  );
  const refs: PageRef[] = pages.map((p) => ({
    id: p.id,
    path: p.path,
    title: p.title,
    aliases: safeJsonArray(p.aliases),
  }));
  const resolver = new LinkResolver(refs);
  const links = await exec.all<{ id: string; raw_target: string; link_type: string }>(
    "SELECT id, raw_target, link_type FROM links WHERE link_type IN ('wikilink', 'embed', 'markdown')",
  );
  let resolved = 0;
  let dangling = 0;
  for (const l of links) {
    const target = resolver.resolve(l.raw_target);
    if (target) {
      await exec.run('UPDATE links SET dst_page_id = ?, resolved = 1 WHERE id = ?', [target.id, l.id]);
      resolved++;
    } else {
      await exec.run('UPDATE links SET dst_page_id = NULL, resolved = 0 WHERE id = ?', [l.id]);
      dangling++;
    }
  }
  return { resolved, dangling };
}

export interface KeywordHit {
  page_id: string;
  path: string;
  title: string;
  tier: string;
  score: number;
  match_type: string;
  snippet: string | null;
  heading: string | null;
  indexed_at: string | null;
}

function ftsQuery(query: string): string {
  // Quote each term to keep FTS5 syntax characters from breaking the query.
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""').trim())
    .filter(Boolean);
  return terms.map((t) => `"${t}"`).join(' ');
}

/** Keyword search: exact title > alias > heading > FTS body (planning §8). */
export async function keywordSearch(
  exec: SqlExec,
  query: string,
  opts: { limit?: number; includeCompiled?: boolean } = {},
): Promise<KeywordHit[]> {
  const limit = opts.limit ?? 10;
  const q = query.trim();
  const like = `%${q}%`;
  const hits = new Map<string, KeywordHit>();

  const add = (h: KeywordHit) => {
    const prev = hits.get(h.page_id);
    if (!prev || h.score > prev.score) hits.set(h.page_id, h);
  };

  const pages = await exec.all<{
    id: string;
    path: string;
    title: string;
    tier: string;
    aliases: string | null;
    tags: string | null;
    indexed_at: string | null;
  }>(
    `SELECT id, path, title, tier, aliases, tags, indexed_at FROM pages
     WHERE deleted_at IS NULL AND (title LIKE ? COLLATE NOCASE OR aliases LIKE ? COLLATE NOCASE OR tags LIKE ? COLLATE NOCASE)
     LIMIT 200`,
    [like, like, like],
  );
  for (const p of pages) {
    const titleExact = p.title.toLowerCase() === q.toLowerCase();
    const aliasMatch = safeJsonArray(p.aliases).some((a) => a.toLowerCase() === q.toLowerCase());
    const tagMatch = safeJsonArray(p.tags).some((t) => t.toLowerCase() === q.toLowerCase());
    const score = titleExact ? 100 : aliasMatch ? 90 : p.title.toLowerCase().includes(q.toLowerCase()) ? 70 : tagMatch ? 60 : 50;
    add({
      page_id: p.id,
      path: p.path,
      title: p.title,
      tier: p.tier,
      score,
      match_type: titleExact ? 'title' : aliasMatch ? 'alias' : tagMatch ? 'tag' : 'title',
      snippet: null,
      heading: null,
      indexed_at: p.indexed_at,
    });
  }

  const headingRows = await exec.all<{
    page_id: string; path: string; title: string; tier: string; htitle: string; indexed_at: string | null;
  }>(
    `SELECT h.page_id, p.path, p.title, p.tier, h.title AS htitle, p.indexed_at
     FROM headings h JOIN pages p ON p.id = h.page_id
     WHERE p.deleted_at IS NULL AND h.title LIKE ? COLLATE NOCASE LIMIT 100`,
    [like],
  );
  for (const r of headingRows) {
    add({
      page_id: r.page_id, path: r.path, title: r.title, tier: r.tier,
      score: 55, match_type: 'heading', snippet: null, heading: r.htitle, indexed_at: r.indexed_at,
    });
  }

  const match = ftsQuery(q);
  if (match) {
    try {
      const ftsRows = await exec.all<{
        page_id: string; path: string; title: string; tier: string; snippet: string; heading: string; rank: number; indexed_at: string | null;
      }>(
        `SELECT f.page_id, p.path, p.title, p.tier, p.indexed_at, f.heading,
                snippet(chunks_fts, 3, '<<', '>>', ' … ', 12) AS snippet,
                bm25(chunks_fts) AS rank
         FROM chunks_fts f JOIN pages p ON p.id = f.page_id
         WHERE chunks_fts MATCH ? AND p.deleted_at IS NULL
         ORDER BY rank LIMIT ?`,
        [match, limit * 3],
      );
      for (const r of ftsRows) {
        // bm25 rank is lower-is-better and negative-ish; map into (0, 50)
        const score = Math.max(1, Math.min(49, 40 - r.rank));
        add({
          page_id: r.page_id, path: r.path, title: r.title, tier: r.tier,
          score, match_type: 'fts', snippet: r.snippet, heading: r.heading || null, indexed_at: r.indexed_at,
        });
      }
    } catch {
      // malformed FTS query — keyword axes above still apply
    }
  }

  let list = [...hits.values()];
  // ADR-008: compiled pages are down-ranked unless explicitly included.
  if (!opts.includeCompiled) {
    for (const h of list) if (h.tier === 'compiled') h.score -= 45;
    list = list.filter((h) => h.score > 0);
  }
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, limit);
}

export interface NeighborRow {
  page_id: string;
  path: string;
  title: string;
  distance: number;
  via: string;
}

export async function expandNeighbors(
  exec: SqlExec,
  pageId: string,
  hops: number,
  limit: number,
): Promise<NeighborRow[]> {
  const seen = new Set<string>([pageId]);
  const out: NeighborRow[] = [];
  let frontier = [pageId];
  for (let d = 1; d <= Math.min(hops, 2) && out.length < limit; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = await exec.all<{ id: string; path: string; title: string; via: string }>(
        `SELECT p.id, p.path, p.title, 'link' AS via
           FROM links l JOIN pages p ON p.id = l.dst_page_id
           WHERE l.src_page_id = ? AND l.resolved = 1 AND p.deleted_at IS NULL
         UNION
         SELECT p.id, p.path, p.title, 'backlink' AS via
           FROM links l JOIN pages p ON p.id = l.src_page_id
           WHERE l.dst_page_id = ? AND l.resolved = 1 AND p.deleted_at IS NULL`,
        [id, id],
      );
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        next.push(r.id);
        out.push({ page_id: r.id, path: r.path, title: r.title, distance: d, via: r.via });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    frontier = next;
  }
  return out;
}

export async function recordError(
  exec: SqlExec,
  type: string,
  message: string,
  targetId?: string,
): Promise<void> {
  const existing = await exec.all<{ id: string }>(
    "SELECT id FROM error_book WHERE type = ? AND message = ? AND status = 'open' LIMIT 1",
    [type, message],
  );
  const first = existing[0];
  if (first) {
    await exec.run(
      'UPDATE error_book SET occurrence_count = occurrence_count + 1 WHERE id = ?',
      [first.id],
    );
  } else {
    await exec.run(
      'INSERT INTO error_book (id, type, target_id, message, status, occurrence_count, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [newId('err'), type, targetId ?? null, message, 'open', new Date().toISOString()],
    );
  }
}

export function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
