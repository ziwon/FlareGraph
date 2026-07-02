# FlareGraph

> Cloudflare-native LLM Wiki, Knowledge Graph, and Agentic Retreival system for Obsidian and Markdown vaults.
>  Cloudflare setup: [docs/deploy.md](docs/deploy.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ziwon/FlareGraph)

FlareGraph keeps an Obsidian vault as the single source of truth, mirrors it to R2, and layers D1 metadata, FTS5 search, BGE-M3 embeddings on Vectorize, an MCP server, and a wiki compiler on top.

## Repository Layout

```text
apps/
  worker/    # Cloudflare Worker: API, MCP, Queue indexer, wiki compiler, search UI
  plugin/    # Obsidian plugin: push triggers, inbox consolidation, status display
  cli/       # Local index/search CLI using node:sqlite and FTS5
packages/
  core/      # Markdown parser, heading-aware chunker, exclusions, wikilink resolver, wiki renderer
  db/        # Drizzle schema, migrations, and shared SQLite/D1 store logic
  contracts/ # API DTOs
  mcp/       # MCP tool definitions split into read, write, and experimental groups
```

## Quick Start

```bash
pnpm install
pnpm -r build

node apps/cli/dist/main.js index ~/Obsidian/MainVault
node apps/cli/dist/main.js search "RDMA"
node apps/cli/dist/main.js links "RDMA"
node apps/cli/dist/main.js graph neighbors "RDMA" --hops 2
node apps/cli/dist/main.js errors list
```

Privacy exclusions are handled before indexing. Add `private: true` to frontmatter, or create `.flaregraph/settings.json` in the vault:

```json
{
  "exclude_folders": ["Private"]
}
```

Excluded files are not written to the index.

## Cloudflare Setup

The Worker exposes the search UI, API routes, indexing hooks, wiki compiler, graph extraction endpoint, and MCP server.

```text
GET  /                      # Search UI
GET  /api/health            # Page count and last index timestamp
GET  /api/search?q=...&mode=hybrid|keyword|semantic|graph
GET  /api/pages
GET  /api/pages/:id
GET  /api/notes/<path>
GET  /api/graph/neighbors/:id
POST /api/capture           # Inbox/new-file capture endpoint
POST /api/index/push        # Obsidian plugin push: {path, checksum}
POST /api/index/rebuild     # Full reindex from the R2 mirror
POST /api/wiki/compile      # {topic} -> new wiki page
POST /api/graph/extract     # {path} -> evidence-backed claim/relation extraction
POST /mcp                   # MCP server: search_notes, read_note, follow_links, ...
```

Authentication is expected through Cloudflare Access email one-time PIN or `Authorization: Bearer <API_TOKEN>`.

See [docs/deploy.md](docs/deploy.md) for resource setup, R2 mirroring, queue wiring, secrets, and remaining manual steps. The button above uses Cloudflare's Workers deploy button flow and requires a public GitHub or GitLab repository.

## Obsidian Sync

FlareGraph does not integrate directly with Obsidian Sync because the official sync protocol is private. Instead, it uses the `remotely-save` Obsidian plugin with R2 through the S3 API.

In this model, R2 is the cloud source layer. Notes written on mobile can sync to R2, trigger Queue events, and be indexed without a desktop client running. See the `remotely-save` section in [docs/deploy.md](docs/deploy.md).

## MCP Connection

```bash
claude mcp add flaregraph --transport http https://<your-worker-host>/mcp \
  --header "Authorization: Bearer <API_TOKEN>"
```

## Development

```bash
just build
just test
just typecheck
just dev-worker
just deploy
```
