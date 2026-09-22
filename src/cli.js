// ps-mcp CLI. Everything an operator needs after install: wire up the MCP
// clients, sign in to Google, and diagnose why a tool is missing.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, constants, copyFileSync, existsSync, mkdirSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBinaries } from './binaries.js';
import { loadManifest } from './manifest.js';
import { S3_TOOL_NAMES } from './s3-tools.js';
import {
  aggregate, appendLedger, attribute, byDomain, collect,
  LEDGER, newRecords, readLedger, since,
} from './usage.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// gws must see the same keyring backend everywhere. The launcher sets it for the
// server; without it here, the CLI would read a DIFFERENT credential store than
// the server does. Worse, gws deletes credentials it cannot decrypt, so a CLI
// call under the wrong backend destroys the server's login.
const GWS_DIR = process.env.PS_MCP_GWS_DIR ?? path.join(homedir(), '.config', 'ps-mcp', 'gws');
const GWS_ENV = {
  ...process.env,
  GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'file',
  // Must match launcher/ps-mcp-launch exactly. If the CLI and the server use
  // different directories, `ps-mcp auth` signs in somewhere the server never
  // looks and doctor reports a login the tools cannot use.
  GOOGLE_WORKSPACE_CLI_CONFIG_DIR: GWS_DIR,
  GOOGLE_WORKSPACE_CLI_LOG_FILE: path.join(GWS_DIR, 'logs'),
};
const CONF = path.join(APP_DIR, 'etc', 'binaries.conf');
const MANIFEST = path.join(APP_DIR, 'etc', 'tools.yaml');
const LAUNCHER = path.join(APP_DIR, 'launcher', 'ps-mcp-launch');
const CLAUDE_CFG = path.join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const CODEX_CFG = path.join(homedir(), '.codex', 'config.toml');
const CLAUDE_CODE_CFG = path.join(homedir(), '.claude.json');
const CHANNEL_FILE = path.join(APP_DIR, 'etc', 'channel');

// Release channels, each the head of the branch of the same name. A build is
// promoted by merging forward: dev -> beta -> stable.
//
// Which channel a machine follows is a local choice, so it is not in git.
const CHANNELS = ['dev', 'beta', 'stable'];
const CHANNEL_HELP = {
  dev: 'every merge to the dev branch; expect breakage',
  beta: 'promoted from dev and soaking; broadly trustworthy',
  stable: 'promoted from beta after soaking; the most conservative',
};

// The middle channel was called `prod` until it was renamed: it sits between dev
// and stable, but `prod` reads as the most conservative tier, which is what
// `stable` is. Migrate rather than silently falling back, or a machine that
// chose the middle tier would be moved to a different one without being told.
const RENAMED = { prod: 'beta' };

function currentChannel() {
  try {
    const value = readFileSync(CHANNEL_FILE, 'utf8').trim();
    if (CHANNELS.includes(value)) return value;
    const renamed = RENAMED[value];
    if (renamed) {
      writeFileSync(CHANNEL_FILE, `${renamed}\n`);
      return renamed;
    }
    return 'stable';
  } catch {
    return 'stable';
  }
}

function channel() {
  const requested = process.argv[3];
  if (!requested) {
    console.log(currentChannel());
    return;
  }
  if (!CHANNELS.includes(requested)) {
    bad(`unknown channel \`${requested}\`; expected one of ${CHANNELS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(CHANNEL_FILE, `${requested}\n`);
  ok(`following the ${requested} channel - ${CHANNEL_HELP[requested]}`);
  console.log('\n  promotion flows forward:  dev -> beta -> stable');
  for (const name of CHANNELS) {
    const mark = name === requested ? '*' : ' ';
    console.log(`   ${mark} ${name.padEnd(7)} ${CHANNEL_HELP[name]}`);
  }
}

let warnings = 0;
const ok = (m) => console.log(`  \u001b[32mok\u001b[0m    ${m}`);
const warn = (m) => {
  warnings++;
  console.log(`  \u001b[33mwarn\u001b[0m  ${m}`);
};
const bad = (m) => console.log(`  \u001b[31mFAIL\u001b[0m  ${m}`);

function backup(file) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const target = `${file}.bak.${stamp}`;
  copyFileSync(file, target);
  return target;
}

// --- setup -----------------------------------------------------------------

function writeClaudeConfig() {
  mkdirSync(path.dirname(CLAUDE_CFG), { recursive: true });
  let config = {};
  if (existsSync(CLAUDE_CFG)) {
    const saved = backup(CLAUDE_CFG);
    config = JSON.parse(readFileSync(CLAUDE_CFG, 'utf8'));
    console.log(`  backed up ${path.basename(saved)}`);
  }
  config.mcpServers = config.mcpServers ?? {};
  const before = JSON.stringify(config.mcpServers['ps-mcp'] ?? null);
  config.mcpServers['ps-mcp'] = { command: LAUNCHER };
  // JSON.stringify leaves non-ASCII alone, so Norwegian paths survive intact.
  writeFileSync(CLAUDE_CFG, `${JSON.stringify(config, null, 2)}\n`);
  return before === JSON.stringify(config.mcpServers['ps-mcp']) ? 'unchanged' : 'written';
}

// Claude Code keeps its MCP servers in ~/.claude.json, the same `mcpServers`
// shape as Claude Desktop but in a much larger file that also holds startup
// counters, cached feature flags and every other server.
//
// We only ever register per project directory, under `projects[dir]`. A global
// registration would put all 30 tools -- about 6,300 tokens -- into the system
// prompt of every Claude Code session on the machine, including the ones that
// have nothing to do with mail or calendars. Scoping is the whole point.
//
// Not `.mcp.json` either: that file is meant to be committed, and the launcher
// path in it is absolute and machine-specific, so it would be wrong for anyone
// who cloned the repo.
export function withPsMcp(config, launcher, project) {
  const projects = { ...(config.projects ?? {}) };
  const entry = projects[project] ?? {};
  projects[project] = {
    ...entry,
    mcpServers: { ...(entry.mcpServers ?? {}), 'ps-mcp': { type: 'stdio', command: launcher, args: [], env: {} } },
  };
  return { ...config, projects };
}

export function withoutPsMcp(config, project) {
  const entry = config.projects?.[project];
  if (!entry?.mcpServers?.['ps-mcp']) return config;
  const mcpServers = { ...entry.mcpServers };
  delete mcpServers['ps-mcp'];
  return { ...config, projects: { ...config.projects, [project]: { ...entry, mcpServers } } };
}

export function psMcpProjects(config) {
  return Object.entries(config.projects ?? {})
    .filter(([, v]) => v && v.mcpServers && v.mcpServers['ps-mcp'])
    .map(([dir]) => dir)
    .sort();
}

const readClaudeCode = () => (existsSync(CLAUDE_CODE_CFG)
  ? JSON.parse(readFileSync(CLAUDE_CODE_CFG, 'utf8'))
  : null);

function saveClaudeCode(next) {
  if (existsSync(CLAUDE_CODE_CFG)) backup(CLAUDE_CODE_CFG);
  // Claude Code rewrites this file while it is running. Write a temp file and
  // rename, so an interrupted write cannot leave it truncated -- losing this
  // file loses every other MCP server the user has configured.
  const tmp = `${CLAUDE_CODE_CFG}.ps-mcp.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, CLAUDE_CODE_CFG);
}

function projectCommand() {
  const sub = process.argv[3] ?? 'list';
  const config = readClaudeCode();
  if (!config) {
    console.log('Claude Code is not installed on this Mac (no ~/.claude.json).');
    return;
  }
  if (sub === 'list') {
    const dirs = psMcpProjects(config);
    if (!dirs.length) {
      console.log('\nps-mcp is not enabled for any project directory.\n');
      console.log('  ps-mcp project add [DIR]    enable it for DIR (default: this directory)\n');
      return;
    }
    console.log('\nps-mcp is enabled in Claude Code for:\n');
    for (const d of dirs) console.log(`  ${d}`);
    console.log('');
    return;
  }
  if (sub !== 'add' && sub !== 'remove') {
    console.log('usage: ps-mcp project <list|add|remove> [DIR]');
    process.exitCode = 1;
    return;
  }
  const given = process.argv[4] ?? process.cwd();
  let dir;
  try {
    dir = realpathSync(given);
  } catch {
    bad(`no such directory: ${given}`);
    process.exitCode = 1;
    return;
  }
  const next = sub === 'add' ? withPsMcp(config, LAUNCHER, dir) : withoutPsMcp(config, dir);
  if (JSON.stringify(next) === JSON.stringify(config)) {
    ok(`${dir}: already ${sub === 'add' ? 'enabled' : 'absent'}`);
    return;
  }
  saveClaudeCode(next);
  ok(`${sub === 'add' ? 'enabled' : 'removed'} ps-mcp for ${dir}`);
  if (sub === 'add') console.log('\n  Start Claude Code in that directory to pick it up.\n');
}

function writeCodexConfig() {
  mkdirSync(path.dirname(CODEX_CFG), { recursive: true });
  const block = `[mcp_servers.ps-mcp]\ncommand = "${LAUNCHER}"\n`;
  let text = existsSync(CODEX_CFG) ? readFileSync(CODEX_CFG, 'utf8') : '';
  if (text.includes('[mcp_servers.ps-mcp]')) {
    // Replace just our section, leaving every other server alone.
    const start = text.indexOf('[mcp_servers.ps-mcp]');
    let end = text.indexOf('\n[', start + 1);
    if (end === -1) end = text.length;
    const next = text.slice(0, start) + block + text.slice(end).replace(/^\n/, '\n');
    if (next === text) return 'unchanged';
    backup(CODEX_CFG);
    writeFileSync(CODEX_CFG, next);
    return 'updated';
  }
  if (existsSync(CODEX_CFG)) backup(CODEX_CFG);
  writeFileSync(CODEX_CFG, text && !text.endsWith('\n') ? `${text}\n\n${block}` : `${text}${text ? '\n' : ''}${block}`);
  return 'written';
}

function setup() {
  console.log('ps-mcp setup\n');
  if (!existsSync(CONF)) {
    console.log('  resolving binaries...');
    spawnSync(path.join(APP_DIR, 'bin', 'ps-mcp-resolve'), { stdio: 'inherit' });
  }
  ok(`Claude Desktop config ${writeClaudeConfig()}`);
  ok(`Codex config ${writeCodexConfig()}`);
  // Claude Code is deliberately not wired up globally here. See withPsMcp.
  if (existsSync(CLAUDE_CODE_CFG)) {
    const dirs = psMcpProjects(JSON.parse(readFileSync(CLAUDE_CODE_CFG, 'utf8')));
    ok(dirs.length
      ? `Claude Code enabled for ${dirs.length} project director${dirs.length === 1 ? 'y' : 'ies'}`
      : 'Claude Code found - run `ps-mcp project add DIR` where you want the tools');
  }
  console.log('\nNext:');
  console.log('  ps-mcp auth      sign in to Google in a browser');
  console.log('  ps-mcp doctor    check everything is wired up');
  console.log('  then restart Claude Desktop.');
}

// --- auth ------------------------------------------------------------------

// gws opens a browser only when it believes it has a terminal. Run from a tool,
// a script or an MCP client it just prints the URL and waits on its loopback
// port, which looks like nothing happening at all. Watch its output and open the
// URL ourselves.
// A URL is only safe to open once we know it is complete, because stdout arrives
// in chunks and a half-received URL opens a broken consent page.
//
// Requiring a trailing newline seemed like the obvious completeness test and was
// wrong: gws prints the URL, then writes nothing more until the browser callback
// returns, so the newline arrives only AFTER authentication. The guard prevented
// us opening the browser at the one moment it mattered.
//
// Instead, check the URL carries the parameters a usable consent URL must have.
// A truncated one is cut before them.
const REQUIRED_PARAMS = ['client_id=', 'redirect_uri=', 'response_type='];

export function extractAuthUrl(text) {
  const m = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/\S+/);
  if (!m) return null;
  const url = m[0];
  return REQUIRED_PARAMS.every((p) => url.includes(p)) ? url : null;
}

function auth() {
  mkdirSync(path.join(GWS_DIR, 'logs'), { recursive: true });
  const { paths } = loadBinaries(CONF);
  const gws = paths.get('gws');
  if (!gws) {
    bad('gws is not resolved. Run bin/ps-mcp-resolve first.');
    process.exitCode = 1;
    return;
  }
  console.log('Signing in to Google. You authenticate as yourself;');
  console.log('the token is stored encrypted in your home directory.\n');

  const child = spawn(gws, ['auth', 'login'], {
    env: GWS_ENV,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  // Watch BOTH streams. gws puts its result JSON on stdout but its diagnostics --
  // including the consent URL prompt -- on stderr, so piping only stdout meant
  // the URL never reached this handler and no browser ever opened. Matching over
  // both also survives gws moving the prompt between them.
  let seen = '';
  let opened = false;
  const watch = (stream, echo) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      echo.write(text);
      if (opened) return;
      seen += text;                 // the URL can straddle two chunks
      const url = extractAuthUrl(seen);
      if (!url) return;
      opened = true;
      const r = spawnSync('open', [url], { stdio: 'ignore' });
      console.log(r.status === 0
        ? '\n  (opened in your browser - approve there to finish)'
        : '\n  (could not open a browser; paste the URL above)');
    });
  };
  watch(child.stdout, process.stdout);
  watch(child.stderr, process.stderr);

  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

// --- doctor ----------------------------------------------------------------

// First line of `<binary> --version`, trimmed to something readable.
function versionOf(binary) {
  for (const flag of ['--version', '-version']) {
    try {
      const out = execFileSync(binary, [flag], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], env: GWS_ENV });
      const line = out.split('\n')[0].trim();
      if (line) return line.length > 60 ? `${line.slice(0, 60)}...` : line;
    } catch { /* try the next flag */ }
  }
  return null;
}

// Which Homebrew formulae have updates waiting. Strictly read-only:
// HOMEBREW_NO_AUTO_UPDATE stops brew from updating itself as a side effect of
// being asked a question.
function brewOutdated() {
  try {
    const out = execFileSync('brew', ['outdated', '--formula', '--json=v2'], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
    });
    const parsed = JSON.parse(out);
    return new Map((parsed.formulae ?? []).map((f) => [f.name, f]));
  } catch {
    return null;
  }
}

function gwsAuthState(gws) {
  try {
    const out = execFileSync(gws, ['auth', 'status'], {
      encoding: 'utf8', timeout: 15000, env: GWS_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],   // gws chats about its keyring on stderr
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function doctor() {
  console.log('ps-mcp doctor\n');
  let failures = 0;

  const resolved = loadBinaries(CONF);
  if (!resolved.present) {
    bad(`${CONF} missing - run bin/ps-mcp-resolve`);
    failures++;
  } else {
    for (const [name, p] of resolved.paths) {
      try {
        accessSync(p, constants.X_OK);
        ok(`${name.padEnd(8)} ${p}`);
      } catch (err) {
        bad(`${name.padEnd(8)} ${p} (${err.code})`);
        failures++;
      }
    }
  }

  console.log('');
  let manifest = null;
  try {
    manifest = loadManifest(MANIFEST, { sdkHandlers: new Set(S3_TOOL_NAMES) });
    ok(`manifest: ${manifest.tools.length} tools available`);
    if (manifest.skipped.length) {
      for (const s of manifest.skipped) warn(`skipped ${s.name}: ${s.reason}`);
    }
  } catch (err) {
    bad(`manifest: ${err.message}`);
    failures++;
  }

  console.log('');
  const outdated = brewOutdated();
  let outdatedHere = 0;
  for (const [name, p] of resolved.paths) {
    const version = versionOf(p);
    if (!version) continue;
    // Only Homebrew-managed tools can be checked this way; gws and a bundled
    // node update through their own channels.
    const formula = p.startsWith('/opt/homebrew/') || p.startsWith('/usr/local/')
      ? ['ffprobe', 'ffmpeg'].includes(name) ? 'ffmpeg' : name
      : null;
    const pending = formula && outdated?.get(formula);
    if (pending) {
      outdatedHere++;
      warn(`${name.padEnd(8)} ${version}  -> ${pending.current_version} available (brew upgrade ${formula})`);
    } else {
      ok(`${name.padEnd(8)} ${version}`);
    }
  }
  if (outdated === null) warn('could not ask brew about updates (not installed, or it failed)');
  else if (outdatedHere) console.log('        run `ps-mcp update` to apply');

  console.log('');
  ok(`channel: ${currentChannel()} (${CHANNEL_HELP[currentChannel()]})`);

  const gws = resolved.paths.get('gws');
  if (gws) {
    const state = gwsAuthState(gws);
    if (!state) {
      warn('gws auth status could not be read');
    } else {
      // `credential_source` names the OAuth CLIENT config, which is present even
      // with nobody signed in -- keying off it reported "authenticated" when the
      // user credentials had been deleted. auth_method is the real signal.
      const signedIn =
        (state.auth_method && state.auth_method !== 'none') ||
        state.encrypted_credentials_exists === true ||
        state.plain_credentials_exists === true;
      if (signedIn) {
        ok(`Google: signed in (${state.auth_method ?? 'oauth2'})`);
      } else {
        warn('Google: NOT signed in - run `ps-mcp auth`');
      }
      if (state.client_config_exists === false) {
        warn('  no OAuth client config; gws needs one before login can start');
      }
    }
  }

  const awsCreds = path.join(homedir(), '.aws', 'credentials');
  if (existsSync(awsCreds)) ok(`AWS: ${awsCreds} present`);
  else warn('AWS: no ~/.aws/credentials - S3 tools will fail until credentials are added');

  console.log('');
  for (const [label, file, needle] of [
    ['Claude Desktop', CLAUDE_CFG, '"ps-mcp"'],
    ['Codex', CODEX_CFG, '[mcp_servers.ps-mcp]'],
  ]) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) ok(`${label} configured`);
    else warn(`${label} not configured - run \`ps-mcp setup\``);
  }

  // Claude Code registers per directory, so "configured" is a list, not a flag.
  if (!existsSync(CLAUDE_CODE_CFG)) ok('Claude Code not installed, nothing to configure');
  else {
    const dirs = psMcpProjects(JSON.parse(readFileSync(CLAUDE_CODE_CFG, 'utf8')));
    if (dirs.length) ok(`Claude Code enabled in ${dirs.length} project director${dirs.length === 1 ? 'y' : 'ies'}`);
    else ok('Claude Code installed, no project directories enabled (`ps-mcp project add DIR`)');
  }

  try {
    accessSync(LAUNCHER, constants.X_OK);
    ok('launcher is executable');
  } catch {
    bad('launcher is not executable');
    failures++;
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed, ${warnings} warning(s).`);
  } else if (warnings > 0) {
    // Saying everything passed while three warnings sit above it is how a health
    // check stops being believed.
    console.log(`\nNo failures, but ${warnings} warning(s) above - some tools will not work.`);
  } else {
    console.log('\nAll checks passed.');
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

// --- update -----------------------------------------------------------------
//
// Keeping the tool binaries current is an explicit goal: ffmpeg in particular
// ships security fixes regularly, and a stale copy is a liability rather than
// merely out of date. Checking is read-only and safe to run often; applying is
// a separate, explicit act.

// --- self-update -----------------------------------------------------------
//
// Each channel has one rolling release, so the URLs never change. version.json
// is small and carries the checksum, which means we can decide whether to
// download 5 MB without downloading 5 MB.
const RELEASE_BASE = process.env.PS_MCP_RELEASE_BASE
  ?? 'https://github.com/Partnerstudio/ps-mcp/releases/download';

const BUILD_FILE = path.join(APP_DIR, 'etc', 'build.json');

export function installedBuild() {
  try {
    return JSON.parse(readFileSync(BUILD_FILE, 'utf8'));
  } catch {
    // A source checkout has no build stamp. That is not an error: it means this
    // copy is managed by git, and replacing it from a tarball would be wrong.
    return null;
  }
}

async function fetchJson(url) {
  // version.json is the index and shares a URL across builds, so it can be
  // served stale from cache. The assets it names are immutable -- their
  // filenames carry the build -- but this one has to be fresh or we compare
  // against a previous build's numbers.
  const res = await fetch(`${url}?t=${Date.now()}`, {
    redirect: 'follow',
    headers: { 'cache-control': 'no-cache' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Written by `ps-mcp setup` on THIS machine and deliberately absent from the
// tarball. They must be carried across a swap or the new install forgets where
// its binaries are and which channel it follows.
const MACHINE_LOCAL = ['etc/binaries.conf', 'etc/channel'];

export function assetUrl(channel, remote) {
  // Built from version.json's own asset name, never assumed, so a change to the
  // naming scheme does not need a matching client release.
  return `${RELEASE_BASE}/release-${channel}/${remote.asset}`;
}

export async function selfUpdateStatus(channel, build) {
  if (!build) return { kind: 'source-checkout' };
  let remote;
  try {
    remote = await fetchJson(`${RELEASE_BASE}/release-${channel}/version.json`);
  } catch (err) {
    return { kind: 'unreachable', error: err.message };
  }
  if (remote.channel !== channel) {
    // Following stable but handed a dev build would be a silent downgrade of
    // everyone's risk appetite.
    return { kind: 'channel-mismatch', remote };
  }
  return remote.version === build.version
    ? { kind: 'current', remote }
    : { kind: 'available', remote };
}

function npmLatest(pkg) {
  try {
    return execFileSync('npm', ['view', pkg, 'version'], {
      encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function gwsInstalled(gws) {
  const v = versionOf(gws);
  const m = v && v.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return m ? m[1] : null;
}

function pendingUpdates() {
  const { paths } = loadBinaries(CONF);
  const pending = [];

  const outdated = brewOutdated();
  if (outdated) {
    const formulae = new Set();
    for (const [name, p] of paths) {
      if (!p.startsWith('/opt/homebrew/') && !p.startsWith('/usr/local/')) continue;
      formulae.add(['ffprobe', 'ffmpeg'].includes(name) ? 'ffmpeg' : name);
    }
    for (const formula of formulae) {
      const hit = outdated.get(formula);
      if (hit) {
        pending.push({
          what: formula,
          from: (hit.installed_versions ?? []).join(', '),
          to: hit.current_version,
          how: ['brew', 'upgrade', formula],
        });
      }
    }
  }

  const gws = paths.get('gws');
  if (gws) {
    const installed = gwsInstalled(gws);
    const latest = npmLatest('@googleworkspace/cli');
    if (installed && latest && installed !== latest) {
      pending.push({
        what: '@googleworkspace/cli',
        from: installed,
        to: latest,
        how: ['npm', 'install', '-g', '@googleworkspace/cli'],
      });
    }
  }
  return pending;
}

async function applySelfUpdate(channel, remote) {
  const parent = path.dirname(APP_DIR);
  const staging = path.join(parent, '.ps-mcp-staging');
  const previous = path.join(parent, '.ps-mcp-previous');
  const archive = path.join(staging, remote.asset);

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  console.log(`  downloading ${remote.asset} (${remote.bytes} bytes)`);
  const res = await fetch(assetUrl(channel, remote), { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

  // Verify before unpacking, not after. An archive that fails the checksum is
  // not something to extract and inspect; it is something to refuse.
  const got = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (got !== remote.sha256) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`checksum mismatch: expected ${remote.sha256}, got ${got}`);
  }
  ok('checksum verified');

  const unpacked = path.join(staging, 'root');
  mkdirSync(unpacked, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', archive, '-C', unpacked], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('tar failed');

  // Sanity-check the tree before trusting it. A truncated or wrong archive that
  // extracts cleanly would otherwise replace a working install with rubble.
  for (const required of ['src/server.js', 'launcher/ps-mcp-launch', 'etc/tools.yaml', 'package.json']) {
    if (!existsSync(path.join(unpacked, required))) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`downloaded tree is missing ${required}; refusing to install it`);
    }
  }
  ok('downloaded tree looks complete');

  for (const rel of MACHINE_LOCAL) {
    const from = path.join(APP_DIR, rel);
    if (existsSync(from)) copyFileSync(from, path.join(unpacked, rel));
  }

  // Two renames, so the window where APP_DIR does not exist is microseconds
  // rather than the length of a copy.
  rmSync(previous, { recursive: true, force: true });
  renameSync(APP_DIR, previous);
  try {
    renameSync(unpacked, APP_DIR);
  } catch (err) {
    renameSync(previous, APP_DIR);   // put it back rather than leave nothing
    throw err;
  }
  rmSync(staging, { recursive: true, force: true });

  ok(`updated to ${remote.version}`);
  console.log(`  previous version kept - \`ps-mcp rollback\` restores it`);
  console.log('  restart Claude Desktop to pick it up.');
  // A shell's cwd follows the inode, not the path, so anyone who ran this from
  // inside the install is now sitting in the replaced copy without being told.
  if (process.cwd().startsWith(APP_DIR)) {
    console.log('\n  note: your shell is still in the OLD directory (cwd follows the');
    console.log(`        inode across a rename). run: cd ${APP_DIR}`);
  }
}

function rollback() {
  const parent = path.dirname(APP_DIR);
  const previous = path.join(parent, '.ps-mcp-previous');
  if (!existsSync(previous)) {
    bad('no previous version to roll back to');
    process.exitCode = 1;
    return;
  }
  const failed = path.join(parent, '.ps-mcp-rolledback');
  rmSync(failed, { recursive: true, force: true });
  renameSync(APP_DIR, failed);
  renameSync(previous, APP_DIR);
  // The version just rolled back FROM becomes the new rollback target, so a
  // second rollback returns you to it rather than stranding you.
  renameSync(failed, previous);
  const build = installedBuild();
  ok(`rolled back to ${build?.version ?? 'the previous version'}`);
  console.log('  restart Claude Desktop to pick it up.');
}

async function update() {
  const check = process.argv.includes('--check');
  console.log(check ? 'ps-mcp update --check\n' : 'ps-mcp update\n');

  const build = installedBuild();
  const channel = currentChannel();
  const self = await selfUpdateStatus(channel, build);
  switch (self.kind) {
    case 'source-checkout':
      ok(`ps-mcp: git checkout on ${channel} - update with git, not this command`);
      break;
    case 'unreachable':
      warn(`ps-mcp: could not reach the ${channel} channel (${self.error})`);
      break;
    case 'channel-mismatch':
      warn(`ps-mcp: ${channel} channel served a ${self.remote.channel} build; refusing`);
      break;
    case 'current':
      ok(`ps-mcp: ${build.version} is current on ${channel}`);
      break;
    case 'available':
      warn(`ps-mcp: ${build.version} -> ${self.remote.version} available on ${channel}`);
      if (!check) {
        try {
          await applySelfUpdate(channel, self.remote);
        } catch (err) {
          bad(`self-update failed: ${err.message}`);
          console.log('  the existing install is untouched.');
          process.exitCode = 1;
          return;
        }
      }
      break;
  }

  const pending = pendingUpdates();
  if (pending.length === 0 && self.kind !== 'available') {
    ok('everything is current');
    return;
  }
  for (const p of pending) {
    warn(`${p.what}: ${p.from || 'installed'} -> ${p.to}`);
  }
  if (check) {
    console.log('\nRun `ps-mcp update` to apply.');
    return;
  }

  console.log('');
  let failed = 0;
  for (const p of pending) {
    console.log(`  $ ${p.how.join(' ')}`);
    const r = spawnSync(p.how[0], p.how.slice(1), { stdio: 'inherit' });
    if (r.status !== 0) {
      bad(`${p.what} failed`);
      failed++;
    }
  }

  // Paths can move between versions, so the record has to be refreshed. This is
  // why the resolver records the stable symlink rather than its target: a brew
  // upgrade normally leaves the recorded path valid, and this is belt and braces.
  console.log('\n  re-resolving binaries...');
  spawnSync(path.join(APP_DIR, 'bin', 'ps-mcp-resolve'), { stdio: 'inherit' });

  // ps-mcp updates itself through its release channel, which is separate.
  console.log(`\n  (ps-mcp itself follows the ${currentChannel()} channel and updates separately)`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// --- usage ------------------------------------------------------------------
//
// The clients already write token accounting to disk. We read it, normalise the
// two formats into one, and keep our own copy -- because they clean theirs up,
// and a pilot report written in week six still needs week one.

const flag = (name) => process.argv.includes(name);
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};
const num = (v) => v.toLocaleString('en-US');

function table(headers, rows, aligns) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `  ${cells
    .map((c, i) => (aligns[i] === 'r' ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i])))
    .join('  ')}`.trimEnd();
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}

function usageReport() {
  const found = collect();
  const held = readLedger();
  const added = newRecords(held, found.records);
  appendLedger(added);

  const day = option('--since');
  const all = since([...held, ...added], day);
  const tools = attribute(all);

  if (flag('--json')) {
    const { rows, totals } = aggregate(all);
    console.log(JSON.stringify({
      since: day, turns: all.length, ledger: LEDGER,
      totals, rows, byTool: tools.byTool, byDomain: byDomain(tools.byTool),
      excluded: tools.excluded, skipped: found.skipped,
    }, null, 2));
    return;
  }

  console.log(`\nps-mcp usage${day ? ` since ${day}` : ''}\n`);
  console.log(`  collected ${num(added.length)} new turn(s); ledger holds ${num(held.length + added.length)}\n`);

  if (flag('--by-tool') || flag('--by-domain')) {
    const wide = flag('--by-tool');
    const rows = wide
      ? tools.byTool.map((t) => [t.tool, t.domain ?? '-', num(t.calls), num(t.entry), num(t.carried)])
      : byDomain(tools.byTool).map((d) => [d.domain, num(d.calls), num(d.entry), num(d.carried)]);
    if (!rows.length) console.log('  nothing to attribute yet');
    else if (wide) table(['tool', 'domain', 'calls', 'entry cost', 'carried cost'], rows, ['l', 'l', 'r', 'r', 'r']);
    else table(['domain', 'calls', 'entry cost', 'carried cost'], rows, ['l', 'r', 'r', 'r']);
    const e = tools.excluded;
    const counted = tools.byTool.reduce((a, t) => a + t.calls, 0);
    const seen = counted + e.compacted + e.multiTool + e.lastTurn;
    // A ranking built from three quarters of the data is useful; one that does
    // not say so is not.
    console.log(`\n  attributed ${num(counted)} of ${num(seen)} tool calls (${Math.round(100 * counted / Math.max(seen, 1))}%)`);
    console.log(`  not attributed: ${num(e.compacted)} context shrank, ${num(e.multiTool)} multi-tool, ${num(e.lastTurn)} last-in-thread`);
    console.log('  entry cost is tokens the result added to context; carried cost is that again for every later turn');
  } else {
    const { rows, totals } = aggregate(all);
    if (!rows.length) console.log('  no token records found yet');
    else {
      table(
        ['source', 'model', 'turns', 'input', 'output', 'cache write', 'cache read'],
        rows.map((r) => [r.source, r.model, num(r.turns), num(r.in), num(r.out), num(r.cache_write), num(r.cache_read)]),
        ['l', 'l', 'r', 'r', 'r', 'r', 'r'],
      );
      console.log(`\n  total tokens: ${num(totals.in + totals.out + totals.cache_write + totals.cache_read)}`);
    }
  }

  // Saying what a number leaves out is part of the number.
  console.log('\n  not counted: Claude Desktop chat keeps no local token record.');
  const sk = found.skipped;
  const notes = [
    sk.parse && `${num(sk.parse)} unparseable line(s)`,
    sk.shape && `${num(sk.shape)} record(s) in an unrecognised shape`,
    sk.iterations && `${num(sk.iterations)} multi-iteration message(s)`,
    sk.mismatch && `${num(sk.mismatch)} session(s) whose deltas disagree with their own total`,
    sk.unreadable.length && `${num(sk.unreadable.length)} unreadable file(s)`,
  ].filter(Boolean);
  if (notes.length) console.log(`  skipped: ${notes.join(', ')}`);
  console.log('');
}

const COMMANDS = { setup, auth, doctor, channel, update, rollback, usage: usageReport, project: projectCommand, serve: () => spawnSync(LAUNCHER, { stdio: 'inherit' }) };
const command = process.argv[2];
if (!command || !COMMANDS[command]) {
  console.log('usage: ps-mcp <setup|auth|doctor|serve>');
  console.log('       ps-mcp channel [dev|beta|stable]');
  console.log('       ps-mcp update [--check]');
  console.log('       ps-mcp usage [--since YYYY-MM-DD] [--by-tool|--by-domain] [--json]');
  console.log('       ps-mcp project <list|add|remove> [DIR]');
  console.log('       ps-mcp rollback');
  process.exitCode = command ? 1 : 0;
} else {
  COMMANDS[command]();
}
