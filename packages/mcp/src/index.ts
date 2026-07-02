// MCP tool definitions (planning §21). The worker exposes these over
// streamable HTTP JSON-RPC; write tools require explicit opt-in (ADR-006).

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: 'read' | 'write' | 'experimental';
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'search_notes',
    description:
      'Hybrid search over the Obsidian vault: keyword (FTS5 over titles/aliases/headings/body), semantic (BGE-M3 embeddings), and graph expansion. Returns note paths, headings, snippets and freshness (indexed_at). Compiled Wiki/ pages are down-ranked unless include_compiled is true.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Search query (Korean/English supported)'),
        mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic', 'graph'], description: 'Retrieval mode, default hybrid' },
        limit: num('Max results, default 10'),
        include_compiled: bool('Rank compiled Wiki/ pages normally (default false)'),
      },
      required: ['query'],
    },
  },
  {
    name: 'read_note',
    description:
      'Read the full canonical markdown of a note from the R2 vault mirror by vault-relative path. Always cite path + heading when using the content.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { path: str('Vault-relative path, e.g. "AI Infra/GPU Fabric RDMA.md"') },
      required: ['path'],
    },
  },
  {
    name: 'list_links',
    description: 'List outgoing links and backlinks of a note (by path or page id), including dangling links.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { path: str('Vault-relative path of the note') },
      required: ['path'],
    },
  },
  {
    name: 'follow_links',
    description: 'Resolve and read the notes a given note links to (1 hop). Returns each target with a content preview.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Vault-relative path of the source note'),
        limit: num('Max linked notes to read, default 5'),
      },
      required: ['path'],
    },
  },
  {
    name: 'expand_neighbors',
    description: 'Expand the knowledge graph around a note: wikilinks, backlinks and shared tags up to N hops (default 1, max 2). Only evidence-backed edges are included by default.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Vault-relative path of the center note'),
        hops: num('1 or 2, default 1'),
        limit: num('Max neighbors, default 20'),
      },
      required: ['path'],
    },
  },
  {
    name: 'find_claims',
    description: 'Find extracted claims mentioning a topic. Each claim carries source path, span and confidence.',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { query: str('Topic or keyword'), limit: num('Max claims, default 20') },
      required: ['query'],
    },
  },
  {
    name: 'capture_note',
    description:
      'Create a NEW markdown note in the vault inbox (R2 inbox/). This is the only write primitive: existing files are never modified by the server (ADR-006). The note reaches the local vault via remotely-save sync.',
    access: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        content: str('Markdown body of the note'),
        title: str('Optional title (used in filename and frontmatter)'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['content'],
    },
  },
  {
    name: 'compile_wiki_page',
    description:
      'Compile a structured wiki page about a topic from raw vault notes using the LLM. Writes a NEW file under R2 Wiki/ (never overwrites; conflicts get a new revision). Compiled pages are excluded from embeddings (ADR-008).',
    access: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        topic: str('Topic to compile, e.g. "RDMA"'),
        category: { type: 'string', enum: ['Concepts', 'Systems', 'People', 'Claims'], description: 'Wiki subfolder, default Concepts' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'find_contradictions',
    description: 'EXPERIMENTAL: look for potentially contradicting claims about a topic. Low confidence; verify against sources.',
    access: 'experimental',
    inputSchema: {
      type: 'object',
      properties: { query: str('Topic') },
      required: ['query'],
    },
  },
];

export function enabledTools(opts: { write: boolean; experimental: boolean }): McpToolDef[] {
  return MCP_TOOLS.filter(
    (t) =>
      t.access === 'read' ||
      (t.access === 'write' && opts.write) ||
      (t.access === 'experimental' && opts.experimental),
  );
}
