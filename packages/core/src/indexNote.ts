import { chunkNote } from './chunker.js';
import { isEmbeddable, isExcluded, tierForPath } from './exclusion.js';
import { pageIdForPath, sha256Hex, shortHash } from './hash.js';
import { parseNote } from './parse.js';
import type { Chunk, ExclusionSettings, ParsedNote, Tier } from './types.js';

export interface PageRecord {
  id: string;
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  frontmatter: Record<string, unknown>;
  tier: Tier;
  checksum: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface HeadingRecord {
  id: string;
  pageId: string;
  level: number;
  title: string;
  slug: string;
  position: number;
}

export interface LinkRecord {
  id: string;
  srcPageId: string;
  rawTarget: string;
  linkType: string;
  anchorText?: string;
  position: number;
}

export interface ChunkRecord extends Chunk {
  id: string; // chunk:{page_id}:{chunk_hash}
  pageId: string;
  embeddable: boolean;
}

export interface IndexedNote {
  page: PageRecord;
  headings: HeadingRecord[];
  links: LinkRecord[];
  chunks: ChunkRecord[];
  parsed: ParsedNote;
  invalidFrontmatter: boolean;
}

/**
 * Pure indexing step shared by the local CLI and the cloud Indexer Worker:
 * content in → all derived rows out. No DB access here.
 */
export async function indexNote(
  path: string,
  content: string,
  settings: ExclusionSettings,
  opts: { pageId?: string } = {},
): Promise<IndexedNote | null> {
  const parsed = parseNote(path, content);
  if (isExcluded(path, parsed.frontmatter, settings)) return null;

  // pageId can be overridden to keep a renamed page's identity (ADR-010).
  const pageId = opts.pageId ?? (await pageIdForPath(path));
  const checksum = await sha256Hex(content);
  const tier = tierForPath(path);

  const headings: HeadingRecord[] = [];
  for (const h of parsed.headings) {
    headings.push({
      id: `h_${await shortHash(`${pageId}:${h.position}:${h.slug}`, 16)}`,
      pageId,
      ...h,
    });
  }

  const links: LinkRecord[] = [];
  for (const l of parsed.links) {
    links.push({
      id: `l_${await shortHash(`${pageId}:${l.position}:${l.rawTarget}`, 16)}`,
      srcPageId: pageId,
      rawTarget: l.rawTarget || (l.fragment ?? ''),
      linkType: l.linkType,
      anchorText: l.anchorText,
      position: l.position,
    });
  }

  const embeddable = isEmbeddable(path);
  const rawChunks = await chunkNote(parsed.body, parsed.bodyOffset);
  const chunks: ChunkRecord[] = rawChunks.map((c) => ({
    ...c,
    id: `chunk:${pageId}:${c.hash}`,
    pageId,
    embeddable,
  }));

  return {
    page: {
      id: pageId,
      path,
      title: parsed.title,
      aliases: parsed.aliases,
      tags: parsed.tags,
      frontmatter: parsed.frontmatter,
      tier,
      checksum,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    },
    headings,
    links,
    chunks,
    parsed,
    invalidFrontmatter: parsed.frontmatter['__invalid_frontmatter'] === true,
  };
}
