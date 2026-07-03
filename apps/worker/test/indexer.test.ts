import type { SqlExec } from '@flaregraph/db';
import { describe, expect, it } from 'vitest';
import type { Env, IndexMessage } from '../src/env.js';
import { rebuildFromMirror } from '../src/indexer/index.js';

class FakeExec implements SqlExec {
  pages = new Map<string, { id: string; path: string; deleted_at: string | null }>();

  async run(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.startsWith('UPDATE pages SET deleted_at')) {
      const [deletedAt, id] = params as [string, string];
      for (const page of this.pages.values()) {
        if (page.id === id) page.deleted_at = deletedAt;
      }
    }
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.startsWith('SELECT path FROM pages WHERE deleted_at IS NULL')) {
      return [...this.pages.values()]
        .filter((p) => !p.deleted_at)
        .map((p) => ({ path: p.path })) as T[];
    }
    if (sql.startsWith('SELECT * FROM pages WHERE path = ?')) {
      const page = this.pages.get(String(params[0]));
      return page && !page.deleted_at ? ([page] as T[]) : [];
    }
    if (sql.startsWith('SELECT id, path, title, aliases FROM pages')) return [];
    if (sql.startsWith('SELECT id, raw_target, link_type FROM links')) return [];
    return [];
  }
}

describe('rebuildFromMirror', () => {
  it('soft-deletes live D1 pages missing from the R2 mirror', async () => {
    const exec = new FakeExec();
    exec.pages.set('Notes/Keep.md', { id: 'keep', path: 'Notes/Keep.md', deleted_at: null });
    exec.pages.set('Notes/Gone.md', { id: 'gone', path: 'Notes/Gone.md', deleted_at: null });
    const sentBatches: { body: IndexMessage }[][] = [];
    const delayedGc: IndexMessage[] = [];
    const env = {
      VAULT: {
        async list() {
          return { objects: [{ key: 'Notes/Keep.md' }], truncated: false };
        },
      },
      INDEX_QUEUE: {
        async send(body: IndexMessage) {
          delayedGc.push(body);
        },
        async sendBatch(messages: { body: IndexMessage }[]) {
          sentBatches.push(messages);
        },
      },
    } as unknown as Env;

    const result = await rebuildFromMirror(env, exec);

    expect(result).toEqual({ enqueued: 1, deleted: 1 });
    expect(sentBatches[0]?.[0]?.body.key).toBe('Notes/Keep.md');
    expect(exec.pages.get('Notes/Gone.md')?.deleted_at).toEqual(expect.any(String));
    expect(delayedGc[0]).toMatchObject({ kind: 'gc', key: 'Notes/Gone.md', pageId: 'gone' });
  });
});
