import matter from 'gray-matter';
import { slugify } from './slug.js';
import type { ParsedHeading, ParsedLink, ParsedNote } from './types.js';

const WIKILINK_RE = /(!)?\[\[([^\][|#]+)?(#[^\][|]+)?(?:\|([^\][]+))?\]\]/g;
const MD_LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const INLINE_TAG_RE = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;

function asStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [String(v)];
}

/** Strip fenced code blocks so links/tags/headings inside them are ignored,
 *  preserving character offsets by replacing content with spaces. */
function maskCodeBlocks(body: string): string {
  let masked = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => m.replace(/[^\n]/g, ' '));
  masked = masked.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return masked;
}

export function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export function parseNote(path: string, content: string): ParsedNote {
  let fm: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = matter(content);
    fm = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // Invalid frontmatter: treat the whole file as body; indexer records an error_book entry.
    fm = { __invalid_frontmatter: true };
  }
  const bodyOffset = content.length - body.length;

  const masked = maskCodeBlocks(body);
  const headings: ParsedHeading[] = [];
  let offset = 0;
  for (const line of masked.split('\n')) {
    const m = HEADING_RE.exec(line);
    if (m && m[1] && m[2]) {
      // Recover original heading text (mask only touches code blocks, but be safe).
      const original = body.slice(offset, offset + line.length);
      const om = HEADING_RE.exec(original);
      const title = (om?.[2] ?? m[2]).trim();
      headings.push({
        level: m[1].length,
        title,
        slug: slugify(title),
        position: bodyOffset + offset,
      });
    }
    offset += line.length + 1;
  }

  const links: ParsedLink[] = [];
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const target = m[2]?.trim();
    const fragment = m[3]?.trim();
    if (!target && !fragment) continue; // [[]] or broken
    links.push({
      rawTarget: target ?? '', // [[#heading]] self-reference has empty target
      fragment: fragment || undefined,
      linkType: m[1] ? 'embed' : 'wikilink',
      anchorText: m[4]?.trim() || undefined,
      position: bodyOffset + (m.index ?? 0),
    });
  }
  for (const m of masked.matchAll(MD_LINK_RE)) {
    const target = m[2] ?? '';
    if (target.startsWith('#')) continue; // in-page anchor
    links.push({
      rawTarget: target,
      linkType: /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? 'url' : 'markdown',
      anchorText: m[1]?.trim() || undefined,
      position: bodyOffset + (m.index ?? 0),
    });
  }

  const tagSet = new Set<string>(asStringArray(fm.tags ?? fm.tag).map((t) => t.replace(/^#/, '')));
  for (const m of masked.matchAll(INLINE_TAG_RE)) {
    if (m[2]) tagSet.add(m[2]);
  }

  const fmTitle = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : undefined;
  const toDateString = (v: unknown): string | undefined => {
    if (v == null) return undefined;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  };
  const created = toDateString(fm.created ?? fm.date ?? fm.created_at);
  const updated = toDateString(fm.updated ?? fm.modified ?? fm.updated_at);

  return {
    title: fmTitle ?? titleFromPath(path),
    aliases: asStringArray(fm.aliases ?? fm.alias),
    tags: [...tagSet].sort(),
    frontmatter: fm,
    headings,
    links,
    body,
    bodyOffset,
    createdAt: created,
    updatedAt: updated,
  };
}
