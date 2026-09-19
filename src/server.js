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
import { runSdkTool } from './sdk-tool.js';
import { S3_TOOL_NAMES, createS3Tools } from './s3-tools.js';
import { workRoot } from './paths.js';
import { log } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = process.env.PS_MCP_MANIFEST ?? path.join(here, '..', 'etc', 'tools.yaml');

export function buildServer(manifest, { handlers = {} } = {}) {
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: 'ps-mcp', version: '0.2.0' },
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
    const args = request.params.arguments ?? {};
    return tool.type === 'exec' ? runExecTool(tool, args) : runSdkTool(tool, args, { handlers });
  });

  return server;
}

async function main() {
  const manifest = loadManifest(MANIFEST, { sdkHandlers: new Set(S3_TOOL_NAMES) });
  const handlers = manifest.s3 ? createS3Tools(manifest.s3) : {};

  log.info('ps-mcp starting', {
    manifest: MANIFEST,
    workRoot: workRoot(),
    awsProfile: process.env.AWS_PROFILE ?? '(default chain)',
    tools: manifest.tools.map((t) => t.name),
    skipped: manifest.skipped.map((t) => t.name),
  });

  const server = buildServer(manifest, { handlers });
  await server.connect(new StdioServerTransport());
  log.info('ps-mcp ready on stdio');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log.error('ps-mcp failed to start', { error: err.message });
    process.exitCode = 1;
  });
}
