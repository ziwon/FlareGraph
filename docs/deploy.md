# Deploying FlareGraph to Cloudflare

A step-by-step guide for deploying your own FlareGraph instance. Everything runs on
Cloudflare's free/pay-as-you-go tiers: Workers, D1, R2, Queues, Vectorize, and Workers AI.

> Looking for the history of the reference deployment? See [deploy-history.md](deploy-history.md).

## Prerequisites

- A Cloudflare account with **R2 enabled** — open [Dashboard → R2](https://dash.cloudflare.com/?to=/:account/r2)
  and click *Enable R2* once (a payment method is required even for the free tier).
- Node.js ≥ 20, pnpm, and [just](https://github.com/casey/just) (optional but convenient).
- Wrangler authentication: `pnpm exec wrangler login`. If you logged in before enabling R2,
  log in again so the OAuth token includes the `r2` scope (`wrangler whoami` lists scopes).

```bash
git clone https://github.com/ziwon/FlareGraph && cd FlareGraph
pnpm install && pnpm -r build
cd apps/worker
```

## 1. Provision resources

```bash
pnpm exec wrangler d1 create flaregraph
pnpm exec wrangler r2 bucket create flaregraph-vault
pnpm exec wrangler queues create flaregraph-index
pnpm exec wrangler queues create flaregraph-index-dlq
pnpm exec wrangler vectorize create flaregraph-chunks --dimensions=1024 --metric=cosine
```

Copy the `database_id` printed by `d1 create` into `apps/worker/wrangler.jsonc`
(`d1_databases[0].database_id`). All other names match the config as committed.

> The dimensions/metric must stay `1024` / `cosine` — that is what `@cf/baai/bge-m3` produces.

## 2. Apply database migrations

```bash
pnpm exec wrangler d1 migrations apply flaregraph --remote
```

## 3. Wire R2 events to the indexer queue

Every write to the vault mirror triggers incremental indexing (planning §5.1):

```bash
pnpm exec wrangler r2 bucket notification create flaregraph-vault \
  --event-type object-create --event-type object-delete --queue flaregraph-index
```

## 4. Set the API token secret

```bash
openssl rand -hex 32          # keep this value — it is your Bearer token
pnpm exec wrangler secret put API_TOKEN
```

Requests must then carry `Authorization: Bearer <token>` (or a Cloudflare Access
identity, see step 6). Without any auth configured the worker fails closed.

## 5. Deploy

```bash
pnpm exec wrangler deploy
```

Smoke test (replace host and token):

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://<worker-host>/api/health
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Hello","content":"# Hi\n\nFirst capture."}' https://<worker-host>/api/capture
# wait ~20s for the R2 event to flow through the queue, then:
curl -s -H "Authorization: Bearer $TOKEN" 'https://<worker-host>/api/search?q=capture'
```

## 6. Email login with Cloudflare Access (optional, recommended)

Protect the worker with your e-mail identity so the search UI works in a browser:

1. [Zero Trust Dashboard](https://one.dash.cloudflare.com) → Access → Applications →
   **Add application** → *Self-hosted*.
2. Domain: your `*.workers.dev` host (or a custom domain routed to the worker).
3. Policy: *Allow* → Include → Emails → your address. The default One-time PIN
   login method is enough — no identity provider setup needed.
4. For scripts/MCP clients, add a *Service Auth* policy and create a Service Token;
   clients then send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
5. Tell the worker to verify Access JWTs — copy the application's **AUD tag** and:

```bash
echo "<team>.cloudflareaccess.com" | pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
echo "<aud-tag>"                   | pnpm exec wrangler secret put ACCESS_AUD
```

Access JWTs and the Bearer token are both accepted, so automation keeps working.

## 7. Sync your Obsidian vault (remotely-save ↔ R2)

FlareGraph never talks to Obsidian's proprietary Sync; the R2 bucket is the cloud
mirror of your vault (ADR-005):

1. Dashboard → R2 → **Manage R2 API Tokens** → *Create API Token* —
   Object Read & Write, scoped to `flaregraph-vault`.
2. In Obsidian, install **remotely-save** and choose S3:
   - Endpoint: `https://<account-id>.r2.cloudflarestorage.com`
   - Region: `auto`, Bucket: `flaregraph-vault`
   - Access Key ID / Secret Access Key: from step 1
3. Run the first sync, then trigger a full index once:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" https://<worker-host>/api/index/rebuild
```

From then on, R2 event notifications keep the index fresh automatically — including
notes written on mobile with no desktop running.

## 8. Install the Obsidian plugin (optional)

Copy `apps/plugin/dist/main.js` and `apps/plugin/manifest.json` into
`<vault>/.obsidian/plugins/flaregraph/`, enable the plugin, and set the worker URL
plus token (or Access service token) in its settings. It gives you:

- instant `{path, checksum}` index pushes on file changes (never sends note bodies)
- an *Consolidate Inbox into daily note* command for MCP-captured notes
- an index status bar item

## 9. Connect an agent over MCP

```bash
claude mcp add flaregraph --transport http https://<worker-host>/mcp \
  --header "Authorization: Bearer <token>"
```

Read tools are always on; write tools (`capture_note`, `compile_wiki_page`) are enabled
by `MCP_ENABLE_WRITE: "true"` in `wrangler.jsonc` — set it to `"false"` and redeploy
to make the server strictly read-only.

## Configuration reference

| Variable (wrangler.jsonc `vars`) | Meaning |
|---|---|
| `EMBEDDING_MODEL` | Workers AI embedding model (default `@cf/baai/bge-m3`) |
| `LLM_MODEL` | Model for the wiki compiler / graph extraction |
| `MCP_ENABLE_WRITE` | `"true"` exposes `capture_note` / `compile_wiki_page` |
| `MCP_ENABLE_EXPERIMENTAL` | `"true"` exposes `find_contradictions` |
| `EXCLUDE_FOLDERS` | comma-separated vault folders to exclude from indexing |

| Secret | Meaning |
|---|---|
| `API_TOKEN` | Bearer token for API/MCP clients |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` — enables Access JWT verification |
| `ACCESS_AUD` | Access application AUD tag |

## Troubleshooting

- **`code: 10042` on any R2 command** — R2 is not enabled on the account yet (step 0),
  or your wrangler OAuth token predates enabling it: run `wrangler login` again.
- **`code: 11020` when creating the event notification** — a rule already exists for the
  bucket/queue pair; check with `wrangler r2 bucket notification list flaregraph-vault`.
- **Search returns nothing right after a sync** — R2 event → queue delivery is
  asynchronous (seconds to ~1 min). `GET /api/health` shows `lastIndexedAt`.
- **Semantic search empty but keyword works** — check the Vectorize index exists and the
  worker logs (`wrangler tail flaregraph`) for Workers AI errors; embedding failures are
  also recorded in `GET /api/errors` and retried by the queue.
- **Rebuilding from scratch** — D1, Vectorize, and even the R2 mirror are derived data.
  Re-sync from the local vault and `POST /api/index/rebuild` restores everything
  (planning §22, criterion 7).
