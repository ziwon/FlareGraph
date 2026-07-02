export interface Env {
  DB: D1Database;
  VAULT: R2Bucket;
  INDEX_QUEUE: Queue<IndexMessage>;
  VECTORS: VectorizeIndex;
  AI: Ai;
  EMBEDDING_MODEL: string;
  LLM_MODEL: string;
  MCP_ENABLE_WRITE: string;
  MCP_ENABLE_EXPERIMENTAL: string;
  EXCLUDE_FOLDERS: string;
  // secrets (optional depending on auth setup)
  API_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string; // e.g. myteam.cloudflareaccess.com
  ACCESS_AUD?: string;
}

/** Queue message: either an R2 event notification or a plugin/API push. */
export interface IndexMessage {
  kind: 'r2-event' | 'push' | 'gc';
  key: string; // vault-relative path == R2 object key
  action?: string; // PutObject | DeleteObject | ... (r2-event)
  checksum?: string; // plugin push
  pageId?: string; // gc
}

export function excludeSettings(env: Env): { excludeFolders: string[] } {
  return {
    excludeFolders: (env.EXCLUDE_FOLDERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
