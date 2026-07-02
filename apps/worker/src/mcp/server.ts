import type { SqlExec } from '@flaregraph/db';
import { enabledTools } from '@flaregraph/mcp';
import { compileWikiPage } from '../compiler.js';
import type { Env } from '../env.js';
import {
  captureNote,
  findClaims,
  followLinks,
  listLinksFor,
  neighborsForPath,
  readNote,
} from '../handlers.js';
import { search } from '../search/hybrid.js';

/** Minimal MCP server over streamable HTTP (JSON responses). Implements
 *  initialize / tools/list / tools/call — enough for Claude & MCP clients. */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2025-03-26';

export async function handleMcp(req: Request, env: Env, exec: SqlExec): Promise<Response> {
  if (req.method === 'GET') {
    // no server-initiated stream support
    return new Response(null, { status: 405 });
  }
  let rpc: JsonRpcRequest;
  try {
    rpc = (await req.json()) as JsonRpcRequest;
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const { id, method, params } = rpc;

  if (method === 'initialize') {
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params?.protocolVersion as string) ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'flaregraph', version: '0.1.0' },
      },
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
    return new Response(null, { status: 202 });
  }
  if (method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });

  const tools = enabledTools({
    write: env.MCP_ENABLE_WRITE === 'true',
    experimental: env.MCP_ENABLE_EXPERIMENTAL === 'true',
  });

  if (method === 'tools/list') {
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      },
    });
  }

  if (method === 'tools/call') {
    const name = params?.name as string;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    if (!tools.some((t) => t.name === name)) {
      return json({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `unknown tool: ${name}` },
      });
    }
    try {
      const result = await callTool(env, exec, name, args);
      return json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        },
      });
    } catch (err) {
      return json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        },
      });
    }
  }
  return json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
}

async function callTool(
  env: Env,
  exec: SqlExec,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'search_notes':
      return search(env, exec, String(args.query ?? ''), {
        mode: (args.mode as never) ?? 'hybrid',
        limit: (args.limit as number) ?? 10,
        includeCompiled: args.include_compiled === true,
      });
    case 'read_note': {
      const note = await readNote(env, exec, String(args.path ?? ''));
      if (!note) throw new Error(`note not found in R2 mirror: ${args.path}`);
      return `<!-- path: ${args.path} | indexed_at: ${note.indexedAt ?? 'never'} -->\n${note.content}`;
    }
    case 'list_links': {
      const links = await listLinksFor(exec, String(args.path ?? ''));
      if (!links) throw new Error(`page not indexed: ${args.path}`);
      return links;
    }
    case 'follow_links': {
      const notes = await followLinks(
        env,
        exec,
        String(args.path ?? ''),
        (args.limit as number) ?? 5,
      );
      if (!notes) throw new Error(`page not indexed: ${args.path}`);
      return notes;
    }
    case 'expand_neighbors': {
      const n = await neighborsForPath(
        exec,
        String(args.path ?? ''),
        Math.min((args.hops as number) ?? 1, 2),
        (args.limit as number) ?? 20,
      );
      if (!n) throw new Error(`page not indexed: ${args.path}`);
      return n;
    }
    case 'find_claims':
      return findClaims(exec, String(args.query ?? ''), (args.limit as number) ?? 20);
    case 'capture_note':
      return captureNote(env, exec, {
        content: String(args.content ?? ''),
        title: args.title ? String(args.title) : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        source: 'mcp',
        tool: 'capture_note',
      });
    case 'compile_wiki_page':
      return compileWikiPage(
        env,
        exec,
        String(args.topic ?? ''),
        args.category ? String(args.category) : 'Concepts',
      );
    case 'find_contradictions': {
      const claims = await findClaims(exec, String(args.query ?? ''), 50);
      return {
        note: 'experimental: pairwise claim review is left to the calling agent',
        claims,
      };
    }
    default:
      throw new Error(`tool not implemented: ${name}`);
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
