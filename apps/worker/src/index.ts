import { Hono } from 'hono';
import type { Env, IndexMessage } from './env.js';
import { D1Exec } from './d1.js';
import { authenticate } from './auth.js';
import { api } from './routes/api.js';
import { handleMcp } from './mcp/server.js';
import { consumeBatch } from './indexer/index.js';

type Ctx = { Bindings: Env; Variables: { exec: D1Exec; subject: string } };

const app = new Hono<Ctx>();

/** Friendly failure while R2 is not yet enabled on the account: any vault
 *  access throws a clear error instead of a TypeError. */
const VAULT_UNAVAILABLE = new Proxy({} as R2Bucket, {
  get() {
    throw new Error('R2 is not enabled on this Cloudflare account yet — enable R2 in the dashboard and redeploy with the VAULT binding (see docs/deploy.md)');
  },
});

app.use('*', async (c, next) => {
  if (!c.env.VAULT) c.env.VAULT = VAULT_UNAVAILABLE;
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth.ok) {
    return c.json({ error: 'unauthorized', hint: 'log in via Cloudflare Access or send Authorization: Bearer <API_TOKEN>' }, 401);
  }
  c.set('subject', auth.subject ?? 'unknown');
  c.set('exec', new D1Exec(c.env.DB));
  await next();
});

// The console UI at / is served from static assets (apps/worker/console).
app.route('/api', api);
app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, c.get('exec')));

app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
});

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const exec = new D1Exec(env.DB);
    // R2 event notifications arrive in their own envelope; normalize to IndexMessage
    const normalized: Message<IndexMessage>[] = batch.messages.map((m) => {
      const body = m.body as Record<string, unknown>;
      if (body && typeof body === 'object' && 'object' in body && 'action' in body) {
        const r2 = body as unknown as { action: string; object: { key: string } };
        return proxyMessage(m, { kind: 'r2-event', key: r2.object.key, action: r2.action });
      }
      return m as Message<IndexMessage>;
    });
    await consumeBatch(env, exec, { ...batch, messages: normalized } as MessageBatch<IndexMessage>);
  },
};

function proxyMessage(m: Message<unknown>, body: IndexMessage): Message<IndexMessage> {
  return {
    id: m.id,
    timestamp: m.timestamp,
    attempts: m.attempts,
    body,
    ack: () => m.ack(),
    retry: (o?: QueueRetryOptions) => m.retry(o),
  };
}
