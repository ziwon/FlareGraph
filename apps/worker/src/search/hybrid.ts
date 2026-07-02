import type { SearchHit, SearchMode, SearchResponse } from '@flaregraph/contracts';
import { expandNeighbors, keywordSearch, type SqlExec } from '@flaregraph/db';
import type { Env } from '../env.js';
import { embedTexts } from './embedding.js';

/** Hybrid retrieval + rerank (planning §8). */
export async function search(
  env: Env,
  exec: SqlExec,
  query: string,
  opts: { mode?: SearchMode; limit?: number; includeCompiled?: boolean } = {},
): Promise<SearchResponse> {
  const mode = opts.mode ?? 'hybrid';
  // clamp caller-provided limits: Vectorize allows topK ≤ 20 with returnMetadata 'all'
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10) || 10, 1), 25);
  const includeCompiled = opts.includeCompiled ?? false;
  const merged = new Map<string, SearchHit>();

  const add = (hit: SearchHit) => {
    const prev = merged.get(hit.pageId);
    if (!prev) merged.set(hit.pageId, hit);
    else {
      // combining evidence from multiple axes boosts the page
      prev.score = Math.max(prev.score, hit.score) + Math.min(prev.score, hit.score) * 0.2;
      prev.snippet = prev.snippet ?? hit.snippet;
      prev.heading = prev.heading ?? hit.heading;
    }
  };

  if (mode === 'hybrid' || mode === 'keyword' || mode === 'graph') {
    const rows = await keywordSearch(exec, query, { limit: limit * 2, includeCompiled });
    for (const r of rows) {
      add({
        pageId: r.page_id,
        path: r.path,
        title: r.title,
        tier: r.tier as SearchHit['tier'],
        score: r.score,
        matchType: r.match_type as SearchHit['matchType'],
        snippet: r.snippet ?? undefined,
        heading: r.heading ?? undefined,
        indexedAt: r.indexed_at,
      });
    }
  }

  if (mode === 'hybrid' || mode === 'semantic') {
    try {
      const [qvec] = await embedTexts(env, [query]);
      if (qvec) {
        const res = await env.VECTORS.query(qvec, {
          topK: Math.min(limit * 2, 20),
          returnMetadata: 'all',
        });
        for (const m of res.matches) {
          const md = (m.metadata ?? {}) as { page_id?: string; path?: string; heading?: string };
          if (!md.page_id || !md.path) continue;
          const pageRows = await exec.all<{
            title: string;
            tier: string;
            indexed_at: string | null;
          }>('SELECT title, tier, indexed_at FROM pages WHERE id = ? AND deleted_at IS NULL', [
            md.page_id,
          ]);
          const page = pageRows[0];
          if (!page) continue; // orphan vector — GC will catch it
          add({
            pageId: md.page_id,
            path: md.path,
            title: page.title,
            tier: page.tier as SearchHit['tier'],
            score: m.score * 45, // semantic ranks below exact title/alias (planning §8)
            matchType: 'semantic',
            heading: md.heading || undefined,
            indexedAt: page.indexed_at,
          });
        }
      }
    } catch (err) {
      console.error('semantic search unavailable', err);
    }
  }

  if (mode === 'hybrid' || mode === 'graph') {
    // expand the graph around the strongest hits
    const seeds = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 3);
    for (const seed of seeds) {
      const neighbors = await expandNeighbors(exec, seed.pageId, 1, 5);
      for (const n of neighbors) {
        if (merged.has(n.page_id)) {
          merged.get(n.page_id)!.score += 5; // evidence-backed edge boost
          continue;
        }
        add({
          pageId: n.page_id,
          path: n.path,
          title: n.title,
          tier: 'raw',
          score: Math.max(5, seed.score * 0.25),
          matchType: 'graph',
          indexedAt: null,
        });
      }
    }
  }

  let hits = [...merged.values()];
  if (!includeCompiled) hits = hits.filter((h) => h.tier !== 'compiled' || h.score > 40);
  hits.sort((a, b) => b.score - a.score);
  return { query, mode, includeCompiled, hits: hits.slice(0, limit) };
}
