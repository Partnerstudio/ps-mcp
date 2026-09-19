// The `exec` entry type: turn validated tool arguments into an argv array and
// run it with execFile. There is never a shell string -- each argv entry stays
// exactly one argument, so interpolation cannot split or inject a token.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { placeholdersIn } from './manifest.js';
import { ToolInputError, bindArgs } from './args.js';
import { workRoot } from './paths.js';
import { clamp, textResult } from './result.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Children get a deliberately small environment, but it must contain the node we
// are running as: CLIs installed via npm start with `#!/usr/bin/env node`, and
// with node absent from PATH they die with a bare "env: node: No such file or
// directory" that looks nothing like the real cause.
const CHILD_ENV = {
  PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: 'en_US.UTF-8',
  // gws reads these to find its config and to keep its key off the Keychain.
  GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: process.env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND,
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR: process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR,
  AWS_PROFILE: process.env.AWS_PROFILE,
};

// A token is dropped whole when any param it references was not supplied, so an
// optional flag and its value can live in one template without conditionals.
export function renderArgv(tool, values) {
  const argv = [];
  for (const group of tool.argv) {
    // Every entry is a group; a plain string in the manifest is a group of one.
    // The group is dropped entirely if any param it references was not supplied.
    if (group.some((token) => placeholdersIn(token).some((ref) => !(ref in values)))) continue;
    for (const token of group) {
      argv.push(token.replace(PLACEHOLDER, (_, ref) => String(values[ref])));
    }
  }
  return argv;
}

// A node-based child inherits this process's permission flags and re-emits the
// --allow-child-process SecurityWarning on its own stderr, which otherwise
// buries the actual failure in the message the model sees.
function stripNodeWarnings(text) {
  return text
    .split('\n')
    .filter((line) => !/^\(node:\d+\) |^\(Use `node --trace-warnings/.test(line))
    .join('\n')
    .trim();
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
      env: CHILD_ENV,
    });
    log.info('exec ok', { tool: tool.name, ms: Date.now() - started });
    return textResult(shapeOutput(tool, stdout));
  } catch (err) {
    const ms = Date.now() - started;
    if (err.killed) {
      log.warn('exec timed out', { tool: tool.name, ms });
      return textResult(`${tool.binaryName} timed out after ${tool.timeoutMs} ms`, true);
    }
    // Some CLIs report failures on stdout and leave stderr empty; without the
    // fallback the model gets an exit code and nothing to act on.
    const detail = stripNodeWarnings(err.stderr || err.stdout || err.message || '');
    log.warn('exec failed', { tool: tool.name, ms, code: err.code });
    return textResult(`${tool.binaryName} exited with code ${err.code}\n${clamp(detail)}`, true);
  }
}
