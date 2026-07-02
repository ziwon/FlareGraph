import { DatabaseSync } from 'node:sqlite';
import type { SqlExec } from '@flaregraph/db';

/** SqlExec adapter over Node's built-in SQLite (FTS5 included, no native deps). */
export class NodeSqliteExec implements SqlExec {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  close(): void {
    this.db.close();
  }
}
