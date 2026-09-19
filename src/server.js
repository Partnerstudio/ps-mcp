// Entry point. Builds the MCP server from etc/tools.yaml and speaks JSON-RPC
// over stdio. Nothing here writes to stdout except the transport.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { loadManifest } from './manifest.js';
import { runExecTool } from './exec-tool.js';
import { workRoot } from './paths.js';
import { log } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = process.env.PS_MCP_MANIFEST ?? path.join(here, '..', 'etc', 'tools.yaml');

export function buildServer(manifest) {
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: 'ps-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.hints.readOnly,
        destructiveHint: tool.hints.destructive,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `unknown tool \`${request.params.name}\``);
    }
    return runExecTool(tool, request.params.arguments ?? {});
  });

  return server;
}

async function main() {
  const manifest = loadManifest(MANIFEST);
  log.info('ps-mcp starting', {
    manifest: MANIFEST,
    workRoot: workRoot(),
    tools: manifest.tools.map((t) => t.name),
    skipped: manifest.skipped.map((t) => t.name),
  });

  const server = buildServer(manifest);
  await server.connect(new StdioServerTransport());
  log.info('ps-mcp ready on stdio');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log.error('ps-mcp failed to start', { error: err.message });
    process.exitCode = 1;
  });
}
