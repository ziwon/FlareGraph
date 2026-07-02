export interface ParsedHeading {
  level: number;
  title: string;
  slug: string;
  position: number; // character offset in the original file
}

export type LinkType = 'wikilink' | 'embed' | 'markdown' | 'url';

export interface ParsedLink {
  rawTarget: string; // link target as written (without alias / heading fragment)
  fragment?: string; // #heading or #^block part, if any
  linkType: LinkType;
  anchorText?: string;
  position: number;
}

export interface ParsedNote {
  title: string;
  aliases: string[];
  tags: string[];
  frontmatter: Record<string, unknown>;
  headings: ParsedHeading[];
  links: ParsedLink[];
  body: string; // content without frontmatter
  bodyOffset: number; // offset of body start in the original file
  createdAt?: string;
  updatedAt?: string;
}

export interface Chunk {
  index: number;
  text: string;
  hash: string; // content hash → chunk id component
  headingSlug?: string;
  tokenCount: number;
  startOffset: number; // offsets into the original file
  endOffset: number;
}

export type Tier = 'raw' | 'compiled' | 'inbox';

export interface ExclusionSettings {
  excludeFolders: string[]; // vault-relative folder prefixes
}
