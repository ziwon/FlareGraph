import { type IndexedNote, indexNote, sha256Hex } from '@flaregraph/core';
import {
  deletePage,
  findPageByChecksum,
  getPageByPath,
  recordError,
  resolveAllLinks,
  type SqlExec,
  savePage,
} from '@flaregraph/db';
import { type Env, excludeSettings, type IndexMessage } from '../env.js';
import { embedChunks, gcPageVectors } from '../search/embedding.js';

/** Index one R2 object into D1 (+ embeddings). Returns false if skipped. */
export async function indexKey(env: Env, exec: SqlExec, key: string): Promise<boolean> {
  const obj = await env.VAULT.get(key);
  const now = new Date().toISOString();
  if (!obj) {
    // object vanished → treat as delete
    await handleDelete(env, exec, key, now);
    return false;
  }
  const content = await obj.text();

  // ADR-010 rename detection: a soft-deleted page with identical checksum
  // keeps its page id, so content-addressed chunk ids (and vectors) survive.
  const checksum = await sha256Hex(content);
  const existing = await getPageByPath(exec, key);
  if (existing && existing.checksum === checksum) return false; // unchanged
  const renamed = existing ? undefined : await findPageByChecksum(exec, checksum);

  const idx = await indexNote(key, content, excludeSettings(env), {
    pageId: renamed?.id,
  });
  if (!idx) {
    // excluded (private / excluded folder): make sure nothing remains in D1
    const pageId = await deletePage(exec, key, now);
    if (pageId) await gcPageVectors(env, exec, pageId);
    return false;
  }
  await savePage(exec, idx, now);
  if (idx.invalidFrontmatter) {
    await recordError(exec, 'invalid_frontmatter', `frontmatter parse failed: ${key}`, idx.page.id);
  }
  if (key.includes('.conflict')) {
    await recordError(exec, 'sync_conflict', `conflict file detected: ${key}`, idx.page.id);
  }
  await gcPageVectors(env, exec, idx.page.id);
  await embedPending(env, exec, idx);
  return true;
}

async function embedPending(env: Env, exec: SqlExec, idx: IndexedNote): Promise<void> {
  const pending = idx.chunks.filter((c) => c.embeddable);
  if (pending.length === 0) return;
  const pendingIds = new Set(
    (
      await exec.all<{ id: string }>(
        "SELECT id FROM chunks WHERE page_id = ? AND embedding_status = 'pending'",
        [idx.page.id],
      )
    ).map((r) => r.id),
  );
  const toEmbed = pending.filter((c) => pendingIds.has(c.id));
  if (toEmbed.length === 0) return;
  try {
    await embedChunks(env, exec, idx.page, toEmbed);
  } catch (err) {
    await recordError(
      exec,
      'embedding_failed',
      `${idx.page.path}: ${err instanceof Error ? err.message : String(err)}`,
      idx.page.id,
    );
    throw err; // let the queue retry
  }
}

export async function handleDelete(
  env: Env,
  exec: SqlExec,
  key: string,
  now: string,
): Promise<void> {
  const pageId = await deletePage(exec, key, now);
  if (!pageId) return;
  // Delay vector GC so a matching create (rename) can reclaim the vectors first.
  // The window covers a typical remotely-save sync interval.
  await env.INDEX_QUEUE.send({ kind: 'gc', key, pageId }, { delaySeconds: 300 });
}

/** Queue consumer: R2 event notifications, plugin pushes, and delayed GC. */
export async function consumeBatch(
  env: Env,
  exec: SqlExec,
  batch: MessageBatch<IndexMessage>,
): Promise<void> {
  const now = new Date().toISOString();
  let changed = false;
  // process deletes first so renames within a batch find the soft-deleted page
  const messages = [...batch.messages].sort((a, b) => {
    const del = (m: Message<IndexMessage>) =>
      m.body.kind === 'r2-event' && isDeleteAction(m.body.action) ? 0 : 1;
    return del(a) - del(b);
  });
  for (const msg of messages) {
    const m = msg.body;
    try {
      if (m.kind !== 'gc' && !m.key.toLowerCase().endsWith('.md')) {
        msg.ack(); // attachments/config synced by remotely-save are not notes
        continue;
      }
      if (m.kind === 'gc') {
        const page = await exec.all<{ deleted_at: string | null }>(
          'SELECT deleted_at FROM pages WHERE id = ?',
          [m.pageId],
        );
        // only GC if the page is still deleted (i.e. it was not a rename)
        if (page[0]?.deleted_at) await gcPageVectors(env, exec, m.pageId!, { all: true });
      } else if (m.kind === 'r2-event' && isDeleteAction(m.action)) {
        await handleDelete(env, exec, m.key, now);
        changed = true;
      } else {
        if (m.kind === 'push' && m.checksum) {
          const existing = await getPageByPath(exec, m.key);
          if (existing?.checksum === m.checksum) {
            msg.ack();
            continue;
          }
          // Plugin pushes race remotely-save's R2 upload. If the mirror does not
          // hold the announced content yet, retry later instead of indexing a
          // stale object; the R2 event will also cover it once the sync lands.
          const obj = await env.VAULT.get(m.key);
          if (!obj || (await sha256Hex(await obj.text())) !== m.checksum) {
            msg.retry({ delaySeconds: 30 });
            continue;
          }
        }
        changed = (await indexKey(env, exec, m.key)) || changed;
      }
      msg.ack();
    } catch (err) {
      console.error('index message failed', m, err);
      msg.retry();
    }
  }
  if (changed) await resolveAllLinks(exec);
}

function isDeleteAction(action?: string): boolean {
  return action === 'DeleteObject' || action === 'LifecycleDeletion';
}

/** Full rebuild from the R2 mirror (planning §22 criterion 7). */
export async function rebuildFromMirror(env: Env, _exec: SqlExec): Promise<{ enqueued: number }> {
  let cursor: string | undefined;
  let enqueued = 0;
  do {
    const listing: R2Objects = await env.VAULT.list({ cursor, limit: 500 });
    const sendBatch = listing.objects
      .filter((o) => o.key.toLowerCase().endsWith('.md'))
      .map((o) => ({
        body: { kind: 'r2-event', key: o.key, action: 'PutObject' } as IndexMessage,
      }));
    for (let i = 0; i < sendBatch.length; i += 100) {
      await env.INDEX_QUEUE.sendBatch(sendBatch.slice(i, i + 100));
    }
    enqueued += sendBatch.length;
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return { enqueued };
}
