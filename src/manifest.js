// Loads and validates etc/tools.yaml into normalized tool descriptors.
//
// Structural problems are author bugs and throw at startup -- a half-loaded
// manifest is worse than no server. A missing *binary* is an environment
// problem, so that tool is skipped with a warning and the rest still serve.
import { accessSync, constants, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { log } from './log.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const PARAM_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'enum']);
const OUTPUTS = new Set(['json', 'text']);
const DEFAULT_TIMEOUT_MS = 30_000;

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

function fail(where, message) {
  throw new ManifestError(`${where}: ${message}`);
}

export function placeholdersIn(token) {
  return [...token.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

function validateParam(param, where) {
  if (!param || typeof param !== 'object') fail(where, 'must be a mapping');
  const { name, type, required = false, description } = param;
  if (typeof name !== 'string' || !name) fail(where, '`name` is required');
  if (!PARAM_TYPES.has(type)) {
    fail(`${where} (${name})`, `\`type\` must be one of ${[...PARAM_TYPES].join(', ')}`);
  }
  if (typeof description !== 'string' || !description) {
    fail(`${where} (${name})`, '`description` is required (the model reads it)');
  }
  if (type === 'enum' && (!Array.isArray(param.values) || param.values.length === 0)) {
    fail(`${where} (${name})`, '`values` is required and must be non-empty for type enum');
  }
  if (param.path && type !== 'string') {
    fail(`${where} (${name})`, '`path: true` is only valid on type string');
  }
  return {
    name,
    type,
    required: Boolean(required),
    path: Boolean(param.path),
    description,
    values: param.values,
    default: param.default,
  };
}

function toJsonSchema(params) {
  const properties = {};
  const required = [];
  for (const param of params) {
    const prop = { description: param.description };
    if (param.type === 'enum') {
      prop.type = 'string';
      prop.enum = param.values;
    } else {
      prop.type = param.type;
    }
    if (param.default !== undefined) prop.default = param.default;
    if (param.path) {
      prop.description += ' Must resolve inside the work root.';
    }
    properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function validateTool(raw, index, binaries) {
  const where = `tools[${index}]${raw?.name ? ` (${raw.name})` : ''}`;
  if (!raw || typeof raw !== 'object') fail(where, 'must be a mapping');

  const { name, type, binary, title, description } = raw;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    fail(where, '`name` is required and must match /^[a-zA-Z0-9_-]{1,64}$/');
  }
  if (type !== 'exec') fail(where, `\`type\` must be "exec" (got ${JSON.stringify(type)})`);
  if (typeof binary !== 'string' || !binaries[binary]) {
    fail(where, `\`binary\` must name a key in top-level \`binaries\` (got ${JSON.stringify(binary)})`);
  }
  if (typeof title !== 'string' || !title) fail(where, '`title` is required');
  if (typeof description !== 'string' || !description) fail(where, '`description` is required');

  const hints = raw.hints;
  if (!hints || typeof hints.readOnly !== 'boolean' || typeof hints.destructive !== 'boolean') {
    fail(where, '`hints.readOnly` and `hints.destructive` are both required booleans');
  }

  const output = raw.output ?? 'text';
  if (!OUTPUTS.has(output)) fail(where, `\`output\` must be one of ${[...OUTPUTS].join(', ')}`);

  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    fail(where, '`timeoutMs` must be a positive integer');
  }

  const rawParams = raw.params ?? [];
  if (!Array.isArray(rawParams)) fail(where, '`params` must be a list');
  const params = rawParams.map((p, i) => validateParam(p, `${where} params[${i}]`));
  const byName = new Map();
  for (const param of params) {
    if (byName.has(param.name)) fail(where, `duplicate param \`${param.name}\``);
    byName.set(param.name, param);
  }

  if (!Array.isArray(raw.argv) || raw.argv.some((t) => typeof t !== 'string')) {
    fail(where, '`argv` must be a list of strings');
  }

  // Every placeholder must name a declared param, and every declared param must
  // be reachable from argv -- an unreferenced param is silently dead otherwise.
  const referenced = new Set();
  for (const token of raw.argv) {
    for (const ref of placeholdersIn(token)) {
      if (!byName.has(ref)) fail(where, `argv references undeclared param \`${ref}\``);
      referenced.add(ref);
    }
  }
  for (const param of params) {
    if (!referenced.has(param.name)) {
      fail(where, `param \`${param.name}\` is declared but never referenced in argv`);
    }
  }

  return {
    name,
    type,
    binaryName: binary,
    binaryPath: binaries[binary],
    title,
    description,
    timeoutMs,
    hints: { readOnly: hints.readOnly, destructive: hints.destructive },
    params,
    argv: [...raw.argv],
    output,
    inputSchema: toJsonSchema(params),
  };
}

export function parseManifest(text, { file = '<manifest>' } = {}) {
  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ManifestError(`${file}: not valid YAML: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object') fail(file, 'must be a mapping');
  if (doc.version !== 1) fail(file, `\`version\` must be 1 (got ${JSON.stringify(doc.version)})`);

  const binaries = doc.binaries ?? {};
  if (typeof binaries !== 'object' || Array.isArray(binaries)) fail(file, '`binaries` must be a mapping');
  for (const [key, value] of Object.entries(binaries)) {
    if (typeof value !== 'string' || !value.startsWith('/')) {
      fail(`${file} binaries.${key}`, 'must be an absolute path');
    }
  }

  if (!Array.isArray(doc.tools) || doc.tools.length === 0) fail(file, '`tools` must be a non-empty list');
  const tools = doc.tools.map((raw, i) => validateTool(raw, i, binaries));

  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) fail(file, `duplicate tool name \`${tool.name}\``);
    seen.add(tool.name);
  }

  return { version: doc.version, binaries, tools };
}

export function loadManifest(file) {
  const manifest = parseManifest(readFileSync(file, 'utf8'), { file });

  const tools = [];
  const skipped = [];
  for (const tool of manifest.tools) {
    try {
      accessSync(tool.binaryPath, constants.X_OK);
      tools.push(tool);
    } catch (err) {
      // ERR_ACCESS_DENIED means node's own permission model blocked the probe,
      // not that the binary is missing -- a launcher grant is wrong.
      const reason =
        err.code === 'ERR_ACCESS_DENIED'
          ? 'blocked by node --permission; add --allow-fs-read for it in launcher/ps-mcp-launch'
          : `not executable (${err.code})`;
      skipped.push({ name: tool.name, binaryPath: tool.binaryPath, reason });
      log.warn('tool skipped', { tool: tool.name, binary: tool.binaryPath, reason });
    }
  }
  return { ...manifest, tools, skipped };
}
