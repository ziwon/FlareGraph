import type { ExclusionSettings, Tier } from './types.js';

export const DEFAULT_EXCLUDE_FOLDERS = ['.obsidian/', '.trash/', '.flaregraph/'];

/** ADR-009: privacy exclusion is applied at the indexer stage, before anything
 *  reaches D1/Vectorize/LLM. */
export function isExcluded(
  path: string,
  frontmatter: Record<string, unknown> | undefined,
  settings: ExclusionSettings,
): boolean {
  const normalized = path.replace(/^\/+/, '');
  if (!normalized.toLowerCase().endsWith('.md')) return true;
  const folders = [...DEFAULT_EXCLUDE_FOLDERS, ...settings.excludeFolders].map((f) =>
    f.endsWith('/') ? f : `${f}/`,
  );
  if (folders.some((f) => normalized.startsWith(f))) return true;
  if (frontmatter && frontmatter['private'] === true) return true;
  return false;
}

/** Tier assignment from path (planning §6.6 / ADR-008). */
export function tierForPath(path: string): Tier {
  const p = path.replace(/^\/+/, '');
  if (p.startsWith('Wiki/')) return 'compiled';
  if (p.startsWith('Inbox/') || p.startsWith('inbox/')) return 'inbox';
  return 'raw';
}

/** ADR-008: compiled pages never enter the embedding index. */
export function isEmbeddable(path: string): boolean {
  return tierForPath(path) !== 'compiled';
}
