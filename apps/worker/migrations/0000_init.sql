-- FlareGraph initial schema (SQLite / D1 portable)
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  aliases TEXT,
  tags TEXT,
  frontmatter TEXT,
  tier TEXT NOT NULL DEFAULT 'raw',
  checksum TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  indexed_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS headings (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  position INTEGER
);
CREATE INDEX IF NOT EXISTS idx_headings_page ON headings(page_id);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  src_page_id TEXT NOT NULL REFERENCES pages(id),
  dst_page_id TEXT,
  raw_target TEXT NOT NULL,
  link_type TEXT NOT NULL,
  anchor_text TEXT,
  position INTEGER,
  resolved INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_page_id);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_page_id);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  aliases TEXT,
  normalized_name TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  text TEXT NOT NULL,
  confidence REAL,
  source_span TEXT,
  extraction_method TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL,
  evidence_page_id TEXT,
  evidence_span TEXT,
  method TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  chunk_index INTEGER NOT NULL,
  heading_id TEXT,
  text_hash TEXT NOT NULL,
  token_count INTEGER,
  start_offset INTEGER,
  end_offset INTEGER,
  embedding_status TEXT DEFAULT 'pending',
  embedded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  page_id UNINDEXED,
  heading,
  body,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS vector_refs (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  vector_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vector_refs_page ON vector_refs(page_id);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  source TEXT NOT NULL,
  tool TEXT,
  status TEXT DEFAULT 'written',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS error_book (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  target_id TEXT,
  message TEXT NOT NULL,
  rule TEXT,
  status TEXT DEFAULT 'open',
  occurrence_count INTEGER DEFAULT 1,
  created_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS compiler_rules (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  derived_from TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT
);
