import type { LinkDto } from '@flaregraph/contracts';
import { newId } from '@flaregraph/core';
import { expandNeighbors, getPageByPath, type SqlExec, safeJsonArray } from '@flaregraph/db';
import type { Env } from './env.js';

/** capture_note (ADR-006): the only write primitive — new files in inbox/ only. */
export async function captureNote(
  env: Env,
  exec: SqlExec,
  input: { content: string; title?: string; tags?: string[]; source: 'mcp' | 'api'; tool?: string },
): Promise<{ r2Key: string; captureId: string }> {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const shortid = crypto.randomUUID().slice(0, 8);
  const slugTitle = input.title
    ? input.title
        .replace(/[\\/:*?"<>|#[\]]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60)
    : 'capture';
  const key = `inbox/${date}-${slugTitle}-${shortid}.md`;

  const fm = [
    '---',
    ...(input.title ? [`title: ${JSON.stringify(input.title)}`] : []),
    `created: ${now.toISOString()}`,
    `source: flaregraph-${input.source}`,
    ...(input.tags?.length
      ? [`tags: [${input.tags.map((t) => JSON.stringify(t)).join(', ')}]`]
      : []),
    '---',
    '',
  ].join('\n');
  const body = `${fm}${input.content}\n`;

  // guaranteed-new key; onlyIf is unsupported for R2 put in all runtimes, and the
  // uuid suffix already makes collisions with existing files practically impossible
  await env.VAULT.put(key, body, { httpMetadata: { contentType: 'text/markdown' } });
  const captureId = newId('cap');
  await exec.run(
    'INSERT INTO captures (id, r2_key, source, tool, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [captureId, key, input.source, input.tool ?? null, 'written', now.toISOString()],
  );
  return { r2Key: key, captureId };
}

export async function readNote(
  env: Env,
  exec: SqlExec,
  path: string,
): Promise<{ content: string; indexedAt: string | null } | null> {
  // Privacy boundary (ADR-009): only notes that passed the indexer's exclusion
  // rules are readable. R2 mirrors the whole vault including private notes, so
  // reading must be gated on the index, never on the mirror alone.
  const page = await getPageByPath(exec, path);
  if (!page) return null;
  const obj = await env.VAULT.get(path);
  if (!obj) return null;
  return { content: await obj.text(), indexedAt: page.indexed_at ?? null };
}

export async function listLinksFor(
  exec: SqlExec,
  path: string,
): Promise<{ outgoing: LinkDto[]; backlinks: LinkDto[] } | null> {
  const page = await getPageByPath(exec, path);
  if (!page) return null;
  const outgoing = await exec.all<{
    src_page_id: string;
    dst_page_id: string | null;
    raw_target: string;
    link_type: string;
    anchor_text: string | null;
    resolved: number;
    dst_path: string | null;
  }>(
    `SELECT l.src_page_id, l.dst_page_id, l.raw_target, l.link_type, l.anchor_text, l.resolved, p.path AS dst_path
     FROM links l LEFT JOIN pages p ON p.id = l.dst_page_id
     WHERE l.src_page_id = ? AND l.link_type IN ('wikilink','embed','markdown','url')`,
    [page.id],
  );
  const backlinks = await exec.all<{
    src_page_id: string;
    raw_target: string;
    link_type: string;
    anchor_text: string | null;
    src_path: string;
  }>(
    `SELECT l.src_page_id, l.raw_target, l.link_type, l.anchor_text, p.path AS src_path
     FROM links l JOIN pages p ON p.id = l.src_page_id
     WHERE l.dst_page_id = ? AND p.deleted_at IS NULL`,
    [page.id],
  );
  return {
    outgoing: outgoing.map((l) => ({
      srcPageId: l.src_page_id,
      dstPageId: l.dst_page_id,
      rawTarget: l.raw_target,
      linkType: l.link_type,
      anchorText: l.anchor_text,
      resolved: l.resolved === 1,
      srcPath: path,
      dstPath: l.dst_path,
    })),
    backlinks: backlinks.map((l) => ({
      srcPageId: l.src_page_id,
      dstPageId: page.id,
      rawTarget: l.raw_target,
      linkType: l.link_type,
      anchorText: l.anchor_text,
      resolved: true,
      srcPath: l.src_path,
      dstPath: path,
    })),
  };
}

export async function followLinks(
  env: Env,
  exec: SqlExec,
  path: string,
  limit = 5,
): Promise<{ path: string; title: string; preview: string }[] | null> {
  const links = await listLinksFor(exec, path);
  if (!links) return null;
  const targets = [
    ...new Set(links.outgoing.filter((l) => l.resolved && l.dstPath).map((l) => l.dstPath!)),
  ].slice(0, limit);
  const out: { path: string; title: string; preview: string }[] = [];
  for (const t of targets) {
    const obj = await env.VAULT.get(t);
    if (!obj) continue;
    const page = await getPageByPath(exec, t);
    out.push({ path: t, title: page?.title ?? t, preview: (await obj.text()).slice(0, 1500) });
  }
  return out;
}

export async function findClaims(exec: SqlExec, query: string, limit = 20) {
  const like = `%${query}%`;
  return exec.all<{
    text: string;
    confidence: number | null;
    source_span: string | null;
    path: string;
  }>(
    `SELECT c.text, c.confidence, c.source_span, p.path FROM claims c
     JOIN pages p ON p.id = c.page_id
     WHERE c.text LIKE ? COLLATE NOCASE AND p.deleted_at IS NULL
     ORDER BY c.confidence DESC LIMIT ?`,
    [like, limit],
  );
}

export async function neighborsForPath(exec: SqlExec, path: string, hops: number, limit: number) {
  const page = await getPageByPath(exec, path);
  if (!page) return null;
  const rows = await expandNeighbors(exec, page.id, hops, limit);
  return rows.map((r) => ({
    pageId: r.page_id,
    path: r.path,
    title: r.title,
    distance: r.distance,
    via: r.via,
  }));
}

export { safeJsonArray };
