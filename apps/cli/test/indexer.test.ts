import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations, expandNeighbors, getPageByPath, keywordSearch } from '@flaregraph/db';
import { migrations } from '@flaregraph/db/migrations';
import { NodeSqliteExec } from '../src/sqlite.js';
import { indexVault } from '../src/indexer.js';

const dir = mkdtempSync(join(tmpdir(), 'flaregraph-test-'));
const vault = join(dir, 'vault');

function setupVault() {
  mkdirSync(join(vault, 'Notes'), { recursive: true });
  mkdirSync(join(vault, 'Private'), { recursive: true });
  mkdirSync(join(vault, 'Wiki/Concepts'), { recursive: true });
  writeFileSync(
    join(vault, 'Notes/RDMA.md'),
    `---\ntitle: RDMA\naliases: [Remote DMA]\ntags: [networking]\n---\n\n# Basics\n\nRDMA bypasses the kernel for zero-copy transfers. See [[InfiniBand]].\n`,
  );
  writeFileSync(
    join(vault, 'Notes/InfiniBand.md'),
    `# InfiniBand\n\nA lossless fabric often used with [[RDMA]]. 한국어 본문 검색 테스트 문장이다.\n`,
  );
  writeFileSync(join(vault, 'Notes/Dangling.md'), `Links to [[Nowhere At All]].\n`);
  writeFileSync(join(vault, 'Private/secret.md'), `---\nprivate: true\n---\nhidden text zebra\n`);
  writeFileSync(
    join(vault, 'Wiki/Concepts/RDMA.md'),
    `---\ntier: compiled\n---\n# RDMA (compiled)\n\nCompiled summary about RDMA transfers.\n`,
  );
}

describe('local indexer (MVP 0)', async () => {
  setupVault();
  const exec = new NodeSqliteExec(join(dir, 'test.sqlite'));
  await applyMigrations(exec, migrations);
  const stats = await indexVault(exec, vault, { excludeFolders: ['Private'] });

  afterAll(() => {
    exec.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes vault files and skips excluded ones (ADR-009)', async () => {
    expect(stats.indexed).toBe(4);
    expect(stats.excluded).toBe(1);
    const zebra = await keywordSearch(exec, 'zebra', {});
    expect(zebra).toHaveLength(0);
    expect(await getPageByPath(exec, 'Private/secret.md')).toBeUndefined();
  });

  it('finds notes by title, alias, and body FTS (Korean included)', async () => {
    const byTitle = await keywordSearch(exec, 'RDMA', {});
    expect(byTitle[0]!.path).toBe('Notes/RDMA.md');
    const byAlias = await keywordSearch(exec, 'Remote DMA', {});
    expect(byAlias[0]!.path).toBe('Notes/RDMA.md');
    const byBody = await keywordSearch(exec, 'zero-copy', {});
    expect(byBody.some((h) => h.path === 'Notes/RDMA.md')).toBe(true);
    const korean = await keywordSearch(exec, '한국어 본문', {});
    expect(korean.some((h) => h.path === 'Notes/InfiniBand.md')).toBe(true);
  });

  it('down-ranks compiled pages unless included (ADR-008)', async () => {
    const normal = await keywordSearch(exec, 'RDMA', { limit: 10 });
    const compiledIdx = normal.findIndex((h) => h.tier === 'compiled');
    const rawIdx = normal.findIndex((h) => h.tier === 'raw');
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    if (compiledIdx >= 0) expect(compiledIdx).toBeGreaterThan(rawIdx);
  });

  it('resolves wikilinks into graph edges and reports dangling links', async () => {
    const rdma = (await getPageByPath(exec, 'Notes/RDMA.md'))!;
    const neighbors = await expandNeighbors(exec, rdma.id, 1, 10);
    expect(neighbors.some((n) => n.path === 'Notes/InfiniBand.md')).toBe(true);
    expect(stats.dangling).toBeGreaterThanOrEqual(1);
    const errors = await exec.all<{ type: string }>(
      "SELECT type FROM error_book WHERE type = 'dangling_link'",
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('is incremental: unchanged files are skipped, deletes are detected', async () => {
    const again = await indexVault(exec, vault, { excludeFolders: ['Private'] });
    expect(again.indexed).toBe(0);
    expect(again.skipped).toBe(4);
    unlinkSync(join(vault, 'Notes/Dangling.md'));
    const afterDelete = await indexVault(exec, vault, { excludeFolders: ['Private'] });
    expect(afterDelete.deleted).toBe(1);
    expect(await getPageByPath(exec, 'Notes/Dangling.md')).toBeUndefined();
  });
});
