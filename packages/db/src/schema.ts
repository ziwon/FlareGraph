import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// pages: metadata only — canonical note bodies live in the Vault / R2 mirror (ADR-005).
export const pages = sqliteTable('pages', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(), // vault-relative path == R2 object key
  title: text('title').notNull(),
  aliases: text('aliases'), // JSON array
  tags: text('tags'), // JSON array
  frontmatter: text('frontmatter'), // JSON
  tier: text('tier').notNull().default('raw'), // raw | compiled | inbox
  checksum: text('checksum').notNull(),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  indexedAt: text('indexed_at'),
  deletedAt: text('deleted_at'),
});

export const headings = sqliteTable(
  'headings',
  {
    id: text('id').primaryKey(),
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id),
    level: integer('level').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    position: integer('position'),
  },
  (t) => [index('idx_headings_page').on(t.pageId)],
);

export const links = sqliteTable(
  'links',
  {
    id: text('id').primaryKey(),
    srcPageId: text('src_page_id')
      .notNull()
      .references(() => pages.id),
    dstPageId: text('dst_page_id'),
    rawTarget: text('raw_target').notNull(),
    linkType: text('link_type').notNull(), // wikilink | embed | markdown | tag | url
    anchorText: text('anchor_text'),
    position: integer('position'),
    resolved: integer('resolved').default(0),
  },
  (t) => [index('idx_links_src').on(t.srcPageId), index('idx_links_dst').on(t.dstPageId)],
);

export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type'),
  aliases: text('aliases'),
  normalizedName: text('normalized_name').notNull(),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const claims = sqliteTable('claims', {
  id: text('id').primaryKey(),
  pageId: text('page_id')
    .notNull()
    .references(() => pages.id),
  text: text('text').notNull(),
  confidence: real('confidence'),
  sourceSpan: text('source_span'),
  extractionMethod: text('extraction_method'),
  createdAt: text('created_at'),
});

export const edges = sqliteTable(
  'edges',
  {
    id: text('id').primaryKey(),
    srcId: text('src_id').notNull(),
    dstId: text('dst_id').notNull(),
    type: text('type').notNull(),
    confidence: real('confidence'),
    evidencePageId: text('evidence_page_id'),
    evidenceSpan: text('evidence_span'),
    method: text('method').notNull(), // deterministic | llm_extracted | llm_inferred
    createdAt: text('created_at'),
  },
  (t) => [index('idx_edges_src').on(t.srcId), index('idx_edges_dst').on(t.dstId)],
);

export const chunks = sqliteTable(
  'chunks',
  {
    id: text('id').primaryKey(), // chunk:{page_id}:{chunk_hash}
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id),
    chunkIndex: integer('chunk_index').notNull(),
    headingId: text('heading_id'),
    textHash: text('text_hash').notNull(),
    tokenCount: integer('token_count'),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    embeddingStatus: text('embedding_status').default('pending'), // pending | embedded | excluded
    embeddedAt: text('embedded_at'),
  },
  (t) => [index('idx_chunks_page').on(t.pageId)],
);

export const vectorRefs = sqliteTable(
  'vector_refs',
  {
    id: text('id').primaryKey(),
    targetType: text('target_type').notNull(), // chunk | page | claim | entity
    targetId: text('target_id').notNull(),
    pageId: text('page_id').notNull(),
    vectorId: text('vector_id').notNull(),
    model: text('model').notNull(),
    dimension: integer('dimension'),
    createdAt: text('created_at'),
  },
  (t) => [index('idx_vector_refs_page').on(t.pageId)],
);

export const captures = sqliteTable('captures', {
  id: text('id').primaryKey(),
  r2Key: text('r2_key').notNull(),
  source: text('source').notNull(), // mcp | api
  tool: text('tool'),
  status: text('status').default('written'), // written | synced | consolidated
  createdAt: text('created_at'),
});

export const errorBook = sqliteTable('error_book', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  targetId: text('target_id'),
  message: text('message').notNull(),
  rule: text('rule'),
  status: text('status').default('open'), // open | resolved | distilled
  occurrenceCount: integer('occurrence_count').default(1),
  createdAt: text('created_at'),
  resolvedAt: text('resolved_at'),
});

export const compilerRules = sqliteTable('compiler_rules', {
  id: text('id').primaryKey(),
  rule: text('rule').notNull(),
  derivedFrom: text('derived_from'), // JSON array of error_book ids
  active: integer('active').default(1),
  createdAt: text('created_at'),
});
