// The `exec` entry type: turn validated tool arguments into an argv array and
// run it with execFile. There is never a shell string -- each argv entry stays
// exactly one argument, so interpolation cannot split or inject a token.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { placeholdersIn } from './manifest.js';
import { ToolInputError, bindArgs } from './args.js';
import { workRoot } from './paths.js';
import { clamp, textResult } from './result.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// A token is dropped whole when any param it references was not supplied, so an
// optional flag and its value can live in one template without conditionals.
export function renderArgv(tool, values) {
  const argv = [];
  for (const token of tool.argv) {
    const refs = placeholdersIn(token);
    if (refs.some((ref) => !(ref in values))) continue;
    argv.push(token.replace(PLACEHOLDER, (_, ref) => String(values[ref])));
  }
  return argv;
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
