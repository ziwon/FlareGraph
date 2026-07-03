# AGENTS.md

Guidance for AI agents and maintainers working in this repository.

## Project Overview

FlareGraph turns an Obsidian or Markdown vault into a Cloudflare-native knowledge backend:

- R2 mirrors the vault through `remotely-save`.
- Queues trigger indexing from R2 object events.
- D1 stores metadata, FTS5 search data, graph records, and operational state.
- Vectorize stores BGE-M3 chunk embeddings.
- A Cloudflare Worker exposes the console UI, REST API, Queue consumer, and MCP server.

The vault remains the source of truth. Server-side write paths must create new files only
(`inbox/` or generated wiki pages) and must not mutate existing vault notes.

## Repository Layout

- `apps/worker/`: Cloudflare Worker, API routes, auth, queue indexer, console UI, MCP server.
- `apps/plugin/`: Obsidian plugin.
- `apps/cli/`: local indexing/search CLI.
- `packages/core/`: Markdown parsing, chunking, exclusion logic, wiki rendering.
- `packages/db/`: D1/SQLite schema, migrations, and store logic.
- `packages/contracts/`: shared DTOs.
- `packages/mcp/`: MCP tool definitions.
- `docs/`: architecture, deployment, and operation notes.
- `e2e/`: Playwright smoke tests.

## Commands

Use the existing workspace commands:

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
pnpm lint
pnpm e2e
```

The `justfile` wraps common workflows:

```bash
just build
just test
just typecheck
just dev-worker
just deploy
```

`just deploy` automatically uses `apps/worker/wrangler.personal.jsonc` when it exists.
That file is gitignored and is the correct place for personal Cloudflare resource IDs,
custom domains, and deployment-specific overrides.

## Development Rules

- Prefer the existing TypeScript, Hono, Drizzle, Wrangler, and pnpm workspace patterns.
- Keep changes scoped to the requested behavior. Avoid unrelated refactors.
- Run focused tests for changed packages, then broader checks when touching shared code.
- Do not bypass auth, privacy exclusions, or the "new files only" server write invariant.
- D1, Vectorize, and R2 mirror data are derived stores. Do not treat them as source of truth.
- For Markdown/vault behavior, preserve Obsidian compatibility and existing link semantics.

## Privacy And De-Identification

This repository may be public. Do not commit personal, account-specific, or deployment-specific
identifiers.

Never commit:

- Cloudflare account IDs, zone IDs, application IDs, AUD tags, queue IDs, rule IDs, D1 UUIDs,
  R2 access keys, service tokens, API tokens, or secret values.
- Personal email addresses, real user names, private hostnames, custom domains, or vault paths
  that identify a person or organization.
- Screenshots, logs, curl output, Wrangler output, or operation notes containing identifiers.
- Real note content from a private vault unless it has been intentionally sanitized.

Use placeholders in committed files:

```text
<worker-host>
<account-id>
<zone-id>
<d1-database-id>
<access-aud-tag>
<team>.cloudflareaccess.com
<vault-path>
```

Keep real deployment values only in local, gitignored files such as:

- `apps/worker/wrangler.personal.jsonc`
- `.dev.vars`
- local shell profiles or secret managers

When updating `docs/operation.md`, write only anonymized operational facts. It is acceptable
to record resource status, dates, counts, and validation results, but not stable identifiers
or private domains. Before finalizing documentation changes, scan for leaks:

```bash
rg -n "@|cloudflareaccess\\.com|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" README.md docs llms.txt apps/worker/wrangler.jsonc .github
```

If a committed template needs a value, use a placeholder. Put the real value in
`wrangler.personal.jsonc` or set it with `wrangler secret put`.

## Cloudflare Configuration

- `apps/worker/wrangler.jsonc` is a template and must stay safe to commit.
- `apps/worker/wrangler.personal.jsonc` is for the operator's actual D1 database ID,
  routes, custom domain, bucket overrides, and queue names.
- Secrets must be set with Wrangler and never written to source files:

```bash
pnpm --dir apps/worker exec wrangler secret put API_TOKEN
pnpm --dir apps/worker exec wrangler secret put ACCESS_TEAM_DOMAIN
pnpm --dir apps/worker exec wrangler secret put ACCESS_AUD
```

Access-protected API automation usually needs both Cloudflare Access service-token headers
and the FlareGraph Bearer token.

## Documentation

- `docs/deploy.md` should remain a reusable setup guide.
- `docs/operation.md` should remain an anonymized reference operation log.
- `llms.txt` should point agents to stable docs and code locations without exposing private
  deployment details.

When renaming docs, update all links with `rg` and verify no stale paths remain.
