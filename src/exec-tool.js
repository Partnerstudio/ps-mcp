// The `exec` entry type: turn validated tool arguments into an argv array and
// run it with execFile. There is never a shell string -- each argv entry stays
// exactly one argument, so interpolation cannot split or inject a token.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { placeholdersIn } from './manifest.js';
import { PathDenied, resolveWorkPath, workRoot } from './paths.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;

export class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolInputError';
  }
}

function checkType(param, value) {
  switch (param.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return param.values.includes(value);
    default:
      return false;
  }
}

// Clients are supposed to honour inputSchema. Re-check anyway: the arguments
// arrive from a model, and inputSchema is a hint to it, not a guarantee.
export function bindArgs(tool, args = {}, { root } = {}) {
  const supplied = args && typeof args === 'object' ? args : {};
  const known = new Set(tool.params.map((p) => p.name));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key)) throw new ToolInputError(`unknown argument \`${key}\``);
  }

  const values = new Map();
  for (const param of tool.params) {
    let value = supplied[param.name];
    if (value === undefined || value === null) value = param.default;
    if (value === undefined || value === null) {
      if (param.required) throw new ToolInputError(`missing required argument \`${param.name}\``);
      continue;
    }
    if (!checkType(param, value)) {
      const expected = param.type === 'enum' ? `one of ${param.values.join(', ')}` : param.type;
      throw new ToolInputError(`argument \`${param.name}\` must be ${expected}`);
    }
    if (param.path) {
      try {
        value = resolveWorkPath(value, root ? { root } : undefined);
      } catch (err) {
        if (err instanceof PathDenied) throw new ToolInputError(`argument \`${param.name}\`: ${err.message}`);
        throw err;
      }
    }
    values.set(param.name, String(value));
  }
  return values;
}

// A token is dropped whole when any param it references was not supplied, so an
// optional flag and its value can live in one template without conditionals.
export function renderArgv(tool, values) {
  const argv = [];
  for (const token of tool.argv) {
    const refs = placeholdersIn(token);
    if (refs.some((ref) => !values.has(ref))) continue;
    argv.push(token.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, ref) => values.get(ref)));
  }
  return argv;
}

function clamp(text) {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n\n[truncated: ${text.length} bytes total]`;
}

function shapeOutput(tool, stdout) {
  if (tool.output !== 'json') return clamp(stdout.trim());
  try {
    return clamp(JSON.stringify(JSON.parse(stdout), null, 2));
  } catch {
    log.warn('tool declared output: json but stdout did not parse', { tool: tool.name });
    return clamp(stdout.trim());
  }
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

export async function runExecTool(tool, args, { root = workRoot() } = {}) {
  let argv;
  try {
    argv = renderArgv(tool, bindArgs(tool, args, { root }));
  } catch (err) {
    if (err instanceof ToolInputError) return textResult(err.message, true);
    throw err;
  }

  log.debug('exec', { tool: tool.name, binary: tool.binaryPath, argv });
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(tool.binaryPath, argv, {
      timeout: tool.timeoutMs,
      maxBuffer: MAX_BUFFER,
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: 'en_US.UTF-8',
      },
    });
    log.info('exec ok', { tool: tool.name, ms: Date.now() - started });
    return textResult(shapeOutput(tool, stdout));
  } catch (err) {
    const ms = Date.now() - started;
    if (err.killed) {
      log.warn('exec timed out', { tool: tool.name, ms });
      return textResult(`${tool.binaryName} timed out after ${tool.timeoutMs} ms`, true);
    }
    const detail = (err.stderr || err.message || '').trim();
    log.warn('exec failed', { tool: tool.name, ms, code: err.code });
    return textResult(`${tool.binaryName} exited with code ${err.code}\n${clamp(detail)}`, true);
  }
}
