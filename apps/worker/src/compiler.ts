import {
  buildWikiPrompt,
  newId,
  renderWikiPage,
  sha256Hex,
  wikiPagePath,
  type WikiCompileResult,
  type WikiSource,
} from '@flaregraph/core';
import { keywordSearch, recordError, type SqlExec } from '@flaregraph/db';
import type { Env } from './env.js';

interface LlmTextResponse {
  response?: string;
}

async function runLlm(env: Env, prompt: string): Promise<string> {
  const res = (await env.AI.run(env.LLM_MODEL as keyof AiModels, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
  } as never)) as unknown as LlmTextResponse;
  return res.response ?? '';
}

function parseJson<T>(raw: string): T | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

/** Wiki Compiler (planning §6.6): read raw sources from R2, compile with the
 *  LLM, write a NEW file under Wiki/ (never overwrite — ADR-006 revisions). */
export async function compileWikiPage(
  env: Env,
  exec: SqlExec,
  topic: string,
  category = 'Concepts',
  maxSources = 5,
): Promise<{ r2Key: string; sources: string[] }> {
  const hits = await keywordSearch(exec, topic, { limit: maxSources * 2, includeCompiled: false });
  const rawHits = hits.filter((h) => h.tier === 'raw').slice(0, maxSources);
  if (rawHits.length === 0) throw new Error(`no raw notes found for topic "${topic}"`);

  const sources: WikiSource[] = [];
  for (const h of rawHits) {
    const obj = await env.VAULT.get(h.path);
    if (obj) sources.push({ path: h.path, title: h.title, body: (await obj.text()).slice(0, 20000) });
  }
  if (sources.length === 0) throw new Error('source notes missing from R2 mirror');

  const rules = await exec.all<{ rule: string }>(
    'SELECT rule FROM compiler_rules WHERE active = 1 ORDER BY created_at DESC LIMIT 20',
  );
  const recentErrors = await exec.all<{ message: string }>(
    "SELECT message FROM error_book WHERE status = 'open' AND type IN ('bad_summary','unsupported_claim','missing_source') ORDER BY created_at DESC LIMIT 5",
  );
  const activeRules = [
    ...rules.map((r) => r.rule),
    ...recentErrors.map((e) => `Avoid repeating this past mistake: ${e.message}`),
  ];

  const raw = await runLlm(env, buildWikiPrompt(topic, sources, activeRules));
  const result = parseJson<WikiCompileResult>(raw);
  if (!result || !result.summary) {
    await recordError(exec, 'bad_summary', `compiler returned unparseable output for "${topic}"`);
    throw new Error('LLM output was not valid JSON');
  }
  // evidence check: drop claims whose source is not among the provided notes
  const validPaths = new Set(sources.map((s) => s.path));
  const dropped = (result.claims ?? []).filter((c) => !validPaths.has(c.sourcePath));
  result.claims = (result.claims ?? []).filter((c) => validPaths.has(c.sourcePath));
  for (const d of dropped) {
    await recordError(exec, 'unsupported_claim', `claim without valid source in "${topic}": ${d.text.slice(0, 120)}`);
  }

  const now = new Date().toISOString();
  const page = renderWikiPage(topic, result, sources, now);
  let key = wikiPagePath(topic, category);
  // never overwrite: existing page (or human-edited conflict) gets a revision file
  const existing = await env.VAULT.head(key);
  if (existing) {
    key = key.replace(/\.md$/, `.rev-${now.replace(/[:.]/g, '-')}.md`);
  }
  await env.VAULT.put(key, page, { httpMetadata: { contentType: 'text/markdown' } });
  await exec.run(
    'INSERT INTO captures (id, r2_key, source, tool, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId('cap'), key, 'api', 'compile_wiki_page', 'written', now],
  );
  // store extracted claims with evidence (planning §2.3)
  for (const c of result.claims) {
    const pageRow = await exec.all<{ id: string }>('SELECT id FROM pages WHERE path = ?', [c.sourcePath]);
    const first = pageRow[0];
    if (!first) continue;
    await exec.run(
      `INSERT INTO claims (id, page_id, text, confidence, source_span, extraction_method, created_at)
       VALUES (?, ?, ?, ?, ?, 'llm_extracted', ?)`,
      [newId('clm'), first.id, c.text, c.confidence ?? 0.5, c.heading ?? null, now],
    );
  }
  await maybeDistillErrors(env, exec);
  return { r2Key: key, sources: sources.map((s) => s.path) };
}

/** Error Book distillation (planning §15): 5+ open errors of one type →
 *  one compiler rule; individual errors become status=distilled. */
export async function maybeDistillErrors(env: Env, exec: SqlExec): Promise<void> {
  const groups = await exec.all<{ type: string; n: number }>(
    "SELECT type, COUNT(*) AS n FROM error_book WHERE status = 'open' GROUP BY type HAVING n >= 5",
  );
  for (const g of groups) {
    const errors = await exec.all<{ id: string; message: string }>(
      "SELECT id, message FROM error_book WHERE status = 'open' AND type = ? LIMIT 20",
      [g.type],
    );
    const prompt = `These recurring errors of type "${g.type}" occurred in a wiki compiler pipeline:\n${errors
      .map((e) => `- ${e.message}`)
      .join('\n')}\n\nWrite ONE short imperative rule (max 200 chars) that, if followed, prevents this class of error. Respond with the rule text only.`;
    const rule = (await runLlm(env, prompt)).trim().split('\n')[0]?.slice(0, 300);
    if (!rule) continue;
    const now = new Date().toISOString();
    await exec.run(
      'INSERT INTO compiler_rules (id, rule, derived_from, active, created_at) VALUES (?, ?, ?, 1, ?)',
      [newId('rule'), rule, JSON.stringify(errors.map((e) => e.id)), now],
    );
    for (const e of errors) {
      await exec.run("UPDATE error_book SET status = 'distilled', resolved_at = ? WHERE id = ?", [now, e.id]);
    }
  }
}

/** MVP 5: LLM entity/claim/relation extraction with mandatory evidence. */
export async function extractGraph(env: Env, exec: SqlExec, path: string): Promise<{ claims: number; edges: number }> {
  const pageRows = await exec.all<{ id: string; title: string }>(
    'SELECT id, title FROM pages WHERE path = ? AND deleted_at IS NULL',
    [path],
  );
  const page = pageRows[0];
  if (!page) throw new Error(`page not indexed: ${path}`);
  const obj = await env.VAULT.get(path);
  if (!obj) throw new Error(`note not in R2 mirror: ${path}`);
  const body = (await obj.text()).slice(0, 16000);

  const prompt = `Extract factual claims and entity relations from this note. Only extract what is explicitly stated. For each item include the exact source sentence as "span".

Respond with JSON only:
{"claims":[{"text":"...","span":"exact sentence","confidence":0.0}],
 "relations":[{"src":"entity A","dst":"entity B","type":"relation_type","span":"exact sentence","confidence":0.0}]}

Note "${page.title}" (${path}):
${body}`;
  const raw = await runLlm(env, prompt);
  const result = parseJson<{
    claims?: { text: string; span?: string; confidence?: number }[];
    relations?: { src: string; dst: string; type: string; span?: string; confidence?: number }[];
  }>(raw);
  if (!result) throw new Error('LLM output was not valid JSON');
  const now = new Date().toISOString();
  let claimCount = 0;
  for (const c of result.claims ?? []) {
    if (!c.span || !body.includes(c.span.slice(0, 40))) continue; // evidence required
    await exec.run(
      `INSERT INTO claims (id, page_id, text, confidence, source_span, extraction_method, created_at)
       VALUES (?, ?, ?, ?, ?, 'llm_extracted', ?)`,
      [newId('clm'), page.id, c.text, c.confidence ?? 0.5, c.span, now],
    );
    claimCount++;
  }
  let edgeCount = 0;
  for (const r of result.relations ?? []) {
    if (!r.span || !body.includes(r.span.slice(0, 40))) continue; // no evidence → no edge (§2.4)
    const srcId = await upsertEntity(exec, r.src, now);
    const dstId = await upsertEntity(exec, r.dst, now);
    await exec.run(
      `INSERT INTO edges (id, src_id, dst_id, type, confidence, evidence_page_id, evidence_span, method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'llm_extracted', ?)`,
      [newId('edge'), srcId, dstId, r.type, r.confidence ?? 0.5, page.id, r.span, now],
    );
    edgeCount++;
  }
  return { claims: claimCount, edges: edgeCount };
}

async function upsertEntity(exec: SqlExec, name: string, now: string): Promise<string> {
  const normalized = name.trim().toLowerCase();
  const rows = await exec.all<{ id: string }>('SELECT id FROM entities WHERE normalized_name = ?', [normalized]);
  const first = rows[0];
  if (first) return first.id;
  const id = newId('ent');
  await exec.run(
    'INSERT INTO entities (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, name.trim(), normalized, now, now],
  );
  return id;
}

export { sha256Hex };
