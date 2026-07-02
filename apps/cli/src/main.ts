#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { migrations } from '@flaregraph/db/migrations';
import {
  applyMigrations,
  expandNeighbors,
  getPageByPath,
  keywordSearch,
} from '@flaregraph/db';
import { NodeSqliteExec } from './sqlite.js';
import { indexVault, loadSettings } from './indexer.js';

const DEFAULT_DB = process.env.FLAREGRAPH_DB ?? 'flaregraph.sqlite';

async function openDb(dbPath: string): Promise<NodeSqliteExec> {
  const exec = new NodeSqliteExec(dbPath);
  await applyMigrations(exec, migrations);
  return exec;
}

async function findPage(exec: NodeSqliteExec, nameOrPath: string) {
  const byPath = await getPageByPath(exec, nameOrPath);
  if (byPath) return byPath;
  const hits = await keywordSearch(exec, nameOrPath, { limit: 1, includeCompiled: true });
  const first = hits[0];
  if (!first) return undefined;
  return getPageByPath(exec, first.path);
}

const program = new Command()
  .name('flaregraph')
  .description('FlareGraph local indexer / search CLI')
  .option('--db <path>', 'SQLite database path', DEFAULT_DB);

program
  .command('init')
  .description('Create the local SQLite database and apply migrations')
  .action(async () => {
    const exec = await openDb(program.opts().db);
    console.log(`initialized ${program.opts().db}`);
    exec.close();
  });

program
  .command('index')
  .argument('<vault>', 'path to the Obsidian vault root')
  .option('--full', 'reindex every file regardless of checksum')
  .description('Scan the vault and (re)build the local index')
  .action(async (vault: string, opts: { full?: boolean }) => {
    const exec = await openDb(program.opts().db);
    const settings = loadSettings(vault);
    const stats = await indexVault(exec, vault, settings, { full: opts.full });
    console.log(
      `scanned ${stats.scanned}, indexed ${stats.indexed}, unchanged ${stats.skipped}, excluded ${stats.excluded}, deleted ${stats.deleted}, dangling links ${stats.dangling}`,
    );
    exec.close();
  });

program
  .command('search')
  .argument('<query>', 'search query')
  .option('-n, --limit <n>', 'max results', '10')
  .option('--include-compiled', 'rank compiled Wiki/ pages normally')
  .option('--semantic', 'semantic search (requires deployed worker; falls back to keyword)')
  .description('Search titles, aliases, tags, headings and full text (FTS5)')
  .action(async (query: string, opts: { limit: string; includeCompiled?: boolean; semantic?: boolean }) => {
    if (opts.semantic) {
      console.error('semantic search runs in the cloud worker; using keyword search locally');
    }
    const exec = await openDb(program.opts().db);
    const hits = await keywordSearch(exec, query, {
      limit: parseInt(opts.limit, 10),
      includeCompiled: opts.includeCompiled,
    });
    for (const h of hits) {
      const extra = h.heading ? ` › ${h.heading}` : '';
      console.log(`${h.score.toFixed(0).padStart(3)}  [${h.match_type}] ${h.path}${extra}`);
      if (h.snippet) console.log(`      ${h.snippet.replace(/\n/g, ' ')}`);
    }
    if (hits.length === 0) console.log('no results');
    exec.close();
  });

program
  .command('read')
  .argument('<path>', 'vault-relative note path')
  .option('--vault <dir>', 'vault root', '.')
  .description('Print the canonical markdown of a note from the local vault')
  .action(async (path: string, opts: { vault: string }) => {
    process.stdout.write(readFileSync(join(opts.vault, path), 'utf8'));
  });

program
  .command('links')
  .argument('<nameOrPath>', 'note title, alias, or path')
  .description('Show outgoing links and backlinks of a note')
  .action(async (nameOrPath: string) => {
    const exec = await openDb(program.opts().db);
    const page = await findPage(exec, nameOrPath);
    if (!page) {
      console.error(`not found: ${nameOrPath}`);
      process.exitCode = 1;
      exec.close();
      return;
    }
    const out = await exec.all<{ raw_target: string; resolved: number; path: string | null }>(
      `SELECT l.raw_target, l.resolved, p.path FROM links l
       LEFT JOIN pages p ON p.id = l.dst_page_id
       WHERE l.src_page_id = ? AND l.link_type IN ('wikilink','embed','markdown')`,
      [page.id],
    );
    const back = await exec.all<{ path: string }>(
      `SELECT p.path FROM links l JOIN pages p ON p.id = l.src_page_id
       WHERE l.dst_page_id = ? AND p.deleted_at IS NULL`,
      [page.id],
    );
    console.log(`# ${page.title} (${page.path})`);
    console.log(`\nOutgoing:`);
    for (const l of out) console.log(`  ${l.resolved ? '→' : '⚠ dangling'} ${l.path ?? l.raw_target}`);
    console.log(`\nBacklinks:`);
    for (const b of back) console.log(`  ← ${b.path}`);
    exec.close();
  });

const graph = program.command('graph').description('Knowledge graph queries');
graph
  .command('neighbors')
  .argument('<nameOrPath>')
  .option('--hops <n>', '1 or 2', '1')
  .option('-n, --limit <n>', 'max neighbors', '20')
  .action(async (nameOrPath: string, opts: { hops: string; limit: string }) => {
    const exec = await openDb(program.opts().db);
    const page = await findPage(exec, nameOrPath);
    if (!page) {
      console.error(`not found: ${nameOrPath}`);
      process.exitCode = 1;
      exec.close();
      return;
    }
    const rows = await expandNeighbors(exec, page.id, parseInt(opts.hops, 10), parseInt(opts.limit, 10));
    for (const r of rows) console.log(`  ${'·'.repeat(r.distance)} [${r.via}] ${r.path}`);
    if (rows.length === 0) console.log('no neighbors');
    exec.close();
  });

program
  .command('verify')
  .option('--api <url>', 'deployed worker base URL', process.env.FLAREGRAPH_API)
  .argument('<vault>', 'local vault root')
  .description('Compare local vault checksums with the cloud index (R2-derived)')
  .action(async (vault: string, opts: { api?: string }) => {
    if (!opts.api) {
      console.error('set --api or FLAREGRAPH_API to the deployed worker URL');
      process.exitCode = 1;
      return;
    }
    const headers: Record<string, string> = {};
    if (process.env.CF_ACCESS_CLIENT_ID) {
      headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
      headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET ?? '';
    }
    const res = await fetch(`${opts.api.replace(/\/$/, '')}/api/pages?limit=10000`, { headers });
    if (!res.ok) {
      console.error(`API error ${res.status}: ${await res.text()}`);
      process.exitCode = 1;
      return;
    }
    const remote = (await res.json()) as { pages: { path: string; checksum: string }[] };
    const remoteMap = new Map(remote.pages.map((p) => [p.path, p.checksum]));
    const settings = loadSettings(vault);
    const { indexNote, sha256Hex } = await import('@flaregraph/core');
    const { readdirSync } = await import('node:fs');
    let mismatched = 0;
    let missingRemote = 0;
    const walk = (dir: string, rel = ''): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name.startsWith('.')) return [];
        const r = rel ? `${rel}/${e.name}` : e.name;
        return e.isDirectory() ? walk(join(dir, e.name), r) : r.toLowerCase().endsWith('.md') ? [r] : [];
      });
    for (const path of walk(vault)) {
      const content = readFileSync(join(vault, path), 'utf8');
      const idx = await indexNote(path, content, settings);
      if (!idx) continue; // excluded — must not be remote either
      const remoteSum = remoteMap.get(path);
      if (!remoteSum) {
        console.log(`missing in cloud: ${path}`);
        missingRemote++;
      } else if (remoteSum !== (await sha256Hex(content))) {
        console.log(`checksum mismatch: ${path}`);
        mismatched++;
      }
      remoteMap.delete(path);
    }
    for (const [path] of remoteMap) console.log(`only in cloud: ${path}`);
    console.log(`\nverify done: ${mismatched} mismatched, ${missingRemote} missing in cloud, ${remoteMap.size} cloud-only`);
    if (mismatched + missingRemote > 0) process.exitCode = 1;
  });

const errors = program.command('errors').description('Error book');
errors.command('list').action(async () => {
  const exec = await openDb(program.opts().db);
  const rows = await exec.all<{ type: string; message: string; occurrence_count: number; status: string }>(
    "SELECT type, message, occurrence_count, status FROM error_book WHERE status != 'resolved' ORDER BY occurrence_count DESC LIMIT 50",
  );
  for (const r of rows) console.log(`[${r.status}] ${r.type} ×${r.occurrence_count}: ${r.message}`);
  if (rows.length === 0) console.log('no open errors');
  exec.close();
});

const rules = program.command('rules').description('Distilled compiler rules');
rules.command('list').action(async () => {
  const exec = await openDb(program.opts().db);
  const rows = await exec.all<{ rule: string; active: number }>(
    'SELECT rule, active FROM compiler_rules ORDER BY created_at DESC LIMIT 50',
  );
  for (const r of rows) console.log(`${r.active ? '●' : '○'} ${r.rule}`);
  if (rows.length === 0) console.log('no rules');
  exec.close();
});

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
