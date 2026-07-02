// API DTOs shared by worker, CLI, and plugin.

export type SearchMode = 'hybrid' | 'keyword' | 'semantic' | 'graph';

export interface SearchHit {
  pageId: string;
  path: string;
  title: string;
  tier: 'raw' | 'compiled' | 'inbox';
  score: number;
  matchType: 'title' | 'alias' | 'heading' | 'fts' | 'semantic' | 'graph' | 'tag';
  snippet?: string;
  heading?: string;
  indexedAt?: string | null;
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  includeCompiled: boolean;
  hits: SearchHit[];
}

export interface PageSummary {
  id: string;
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  tier: string;
  checksum: string;
  indexedAt: string | null;
  updatedAt: string | null;
}

export interface PageDetail extends PageSummary {
  headings: { level: number; title: string; slug: string }[];
  outgoingLinks: LinkDto[];
  backlinks: LinkDto[];
}

export interface LinkDto {
  srcPageId: string;
  dstPageId: string | null;
  rawTarget: string;
  linkType: string;
  anchorText?: string | null;
  resolved: boolean;
  srcPath?: string;
  dstPath?: string | null;
}

export interface NeighborNode {
  pageId: string;
  path: string;
  title: string;
  distance: number;
  via: string; // link | backlink | tag:<name>
}

export interface CaptureRequest {
  title?: string;
  content: string;
  tags?: string[];
  source?: string;
}

export interface CaptureResponse {
  r2Key: string;
  captureId: string;
}

export interface IndexPushRequest {
  path: string;
  checksum: string;
  deleted?: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  pages: number;
  lastIndexedAt: string | null;
}

export interface CompileRequest {
  topic: string;
  category?: string;
  maxSources?: number;
}

export interface CompileResponse {
  r2Key: string;
  sources: string[];
}
