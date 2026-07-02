import { type ChunkRecord, newId, type PageRecord } from '@flaregraph/core';
import type { SqlExec } from '@flaregraph/db';
import type { Env } from '../env.js';

const DIMENSION = 1024; // bge-m3

interface BgeM3Response {
  data: number[][];
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  // Workers AI batch limit is conservative; embed in slices of 20.
  for (let i = 0; i < texts.length; i += 20) {
    const slice = texts.slice(i, i + 20);
    const res = (await env.AI.run(
      env.EMBEDDING_MODEL as keyof AiModels,
      {
        text: slice,
      } as never,
    )) as unknown as BgeM3Response;
    out.push(...res.data);
  }
  return out;
}

/** Embed chunks and upsert vectors + vector_refs (planning §6.3). */
export async function embedChunks(
  env: Env,
  exec: SqlExec,
  page: PageRecord,
  chunks: ChunkRecord[],
): Promise<void> {
  if (chunks.length === 0) return;
  const vectors = await embedTexts(
    env,
    chunks.map((c) => c.text),
  );
  const now = new Date().toISOString();
  const upserts: VectorizeVector[] = chunks.map((c, i) => ({
    id: c.id,
    values: vectors[i]!,
    // only lightweight metadata — never full note bodies (planning §6.3)
    metadata: { chunk_id: c.id, page_id: page.id, path: page.path, heading: c.headingSlug ?? '' },
  }));
  await env.VECTORS.upsert(upserts);
  for (const c of chunks) {
    await exec.run(
      `INSERT INTO vector_refs (id, target_type, target_id, page_id, vector_id, model, dimension, created_at)
       VALUES (?, 'chunk', ?, ?, ?, ?, ?, ?)`,
      [newId('vref'), c.id, page.id, c.id, env.EMBEDDING_MODEL, DIMENSION, now],
    );
    await exec.run(
      "UPDATE chunks SET embedding_status = 'embedded', embedded_at = ? WHERE id = ?",
      [now, c.id],
    );
  }
}

/**
 * Stale vector GC (ADR-010): diff vector_refs against the live chunk set and
 * delete vectors whose content-addressed ids disappeared. With { all: true }
 * every vector of the page is deleted (page deletion flow).
 */
export async function gcPageVectors(
  env: Env,
  exec: SqlExec,
  pageId: string,
  opts: { all?: boolean } = {},
): Promise<number> {
  const refs = await exec.all<{ id: string; vector_id: string; target_id: string }>(
    "SELECT id, vector_id, target_id FROM vector_refs WHERE page_id = ? AND target_type = 'chunk'",
    [pageId],
  );
  if (refs.length === 0) return 0;
  let stale = refs;
  if (!opts.all) {
    const live = new Set(
      (await exec.all<{ id: string }>('SELECT id FROM chunks WHERE page_id = ?', [pageId])).map(
        (r) => r.id,
      ),
    );
    stale = refs.filter((r) => !live.has(r.target_id));
  }
  if (stale.length === 0) return 0;
  await env.VECTORS.deleteByIds(stale.map((r) => r.vector_id));
  for (const r of stale) await exec.run('DELETE FROM vector_refs WHERE id = ?', [r.id]);
  return stale.length;
}
