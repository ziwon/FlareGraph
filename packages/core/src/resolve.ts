/** Wikilink target resolution, mirroring Obsidian's shortest-path semantics
 *  closely enough for graph building. */
export interface PageRef {
  id: string;
  path: string; // vault-relative, e.g. "Notes/RDMA.md"
  title: string;
  aliases: string[];
}

export class LinkResolver {
  private byPath = new Map<string, PageRef>();
  private byBasename = new Map<string, PageRef[]>();
  private byTitleOrAlias = new Map<string, PageRef[]>();

  constructor(pages: Iterable<PageRef>) {
    for (const p of pages) {
      this.byPath.set(p.path.toLowerCase(), p);
      const base = (p.path.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase();
      push(this.byBasename, base, p);
      push(this.byTitleOrAlias, p.title.toLowerCase(), p);
      for (const a of p.aliases) push(this.byTitleOrAlias, a.toLowerCase(), p);
    }
  }

  /** Returns the target page or undefined (dangling link). */
  resolve(rawTarget: string): PageRef | undefined {
    const target = rawTarget.trim();
    if (!target) return undefined;
    const lower = target.toLowerCase();
    const withMd = lower.endsWith('.md') ? lower : `${lower}.md`;
    // 1. exact vault-relative path
    const byPath = this.byPath.get(withMd) ?? this.byPath.get(lower);
    if (byPath) return byPath;
    // 2. basename (Obsidian default link format)
    const base = (lower.split('/').pop() ?? lower).replace(/\.md$/i, '');
    const cands = this.byBasename.get(base);
    if (cands && cands.length > 0) {
      // prefer shortest path on ambiguity
      return [...cands].sort((a, b) => a.path.length - b.path.length)[0];
    }
    // 3. title or alias
    const named = this.byTitleOrAlias.get(lower);
    if (named && named.length > 0) {
      return [...named].sort((a, b) => a.path.length - b.path.length)[0];
    }
    return undefined;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}
