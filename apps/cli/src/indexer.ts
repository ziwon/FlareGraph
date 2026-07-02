import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DEFAULT_EXCLUDE_FOLDERS,
  type ExclusionSettings,
  indexNote,
  sha256Hex,
} from '@flaregraph/core';
import {
  deletePage,
  getPageChecksum,
  recordError,
  resolveAllLinks,
  type SqlExec,
  savePage,
} from '@flaregraph/db';

export interface IndexStats {
  scanned: number;
  indexed: number;
  skipped: number;
  excluded: number;
  deleted: number;
  dangling: number;
}

function* walk(dir: string, root: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .obsidian, .trash, .flaregraph, .git
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, root);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      yield relative(root, full).split('\\').join('/');
  }
}

export async function indexVault(
  exec: SqlExec,
  vaultRoot: string,
  settings: ExclusionSettings,
  opts: { full?: boolean } = {},
): Promise<IndexStats> {
  const stats: IndexStats = {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    excluded: 0,
    deleted: 0,
    dangling: 0,
  };
  const now = new Date().toISOString();
  const seen = new Set<string>();

  for (const path of walk(vaultRoot, vaultRoot)) {
    stats.scanned++;
    const abs = join(vaultRoot, path);
    if (!statSync(abs).isFile()) continue;
    const content = readFileSync(abs, 'utf8');
    const checksum = await sha256Hex(content);
    seen.add(path);

    if (!opts.full && (await getPageChecksum(exec, path)) === checksum) {
      stats.skipped++;
      continue;
    }
    const idx = await indexNote(path, content, settings);
    if (!idx) {
      // ADR-009: excluded notes must not exist in the index at all.
      await deletePage(exec, path, now);
      stats.excluded++;
      continue;
    }
    await savePage(exec, idx, now);
    if (idx.invalidFrontmatter) {
      await recordError(
        exec,
        'invalid_frontmatter',
        `frontmatter parse failed: ${path}`,
        idx.page.id,
      );
    }
    if (path.includes('.conflict')) {
      await recordError(exec, 'sync_conflict', `conflict file detected: ${path}`, idx.page.id);
    }
    stats.indexed++;
  }

  // deletion detection: pages in the index that vanished from disk
  const dbPages = await exec.all<{ path: string }>(
    'SELECT path FROM pages WHERE deleted_at IS NULL',
  );
  for (const p of dbPages) {
    if (!seen.has(p.path)) {
      await deletePage(exec, p.path, now);
      stats.deleted++;
    }
  }

  const { dangling } = await resolveAllLinks(exec);
  stats.dangling = dangling;
  const danglingRows = await exec.all<{ raw_target: string; path: string }>(
    `SELECT l.raw_target, p.path FROM links l JOIN pages p ON p.id = l.src_page_id
     WHERE l.resolved = 0 AND l.link_type IN ('wikilink','embed') AND p.deleted_at IS NULL`,
  );
  for (const d of danglingRows) {
    await recordError(exec, 'dangling_link', `[[${d.raw_target}]] in ${d.path}`);
  }
  return stats;
}

export function loadSettings(vaultRoot: string): ExclusionSettings {
  try {
    const raw = readFileSync(join(vaultRoot, '.flaregraph', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { exclude_folders?: string[] };
    return { excludeFolders: parsed.exclude_folders ?? [] };
  } catch {
    return { excludeFolders: [] };
  }
}

export { DEFAULT_EXCLUDE_FOLDERS };
