import type { SqlExec } from '@flaregraph/db';

export class D1Exec implements SqlExec {
  constructor(private db: D1Database) {}

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.db
      .prepare(sql)
      .bind(...params)
      .run();
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.db
      .prepare(sql)
      .bind(...params)
      .all<T>();
    return res.results ?? [];
  }
}
