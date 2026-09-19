// ps-mcp CLI. Everything an operator needs after install: wire up the MCP
// clients, sign in to Google, and diagnose why a tool is missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBinaries } from './binaries.js';
import { loadManifest } from './manifest.js';
import { S3_TOOL_NAMES } from './s3-tools.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONF = path.join(APP_DIR, 'etc', 'binaries.conf');
const MANIFEST = path.join(APP_DIR, 'etc', 'tools.yaml');
const LAUNCHER = path.join(APP_DIR, 'launcher', 'ps-mcp-launch');
const CLAUDE_CFG = path.join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const CODEX_CFG = path.join(homedir(), '.codex', 'config.toml');
const CHANNEL_FILE = path.join(APP_DIR, 'etc', 'channel');

// Release channels, each the head of the branch of the same name. A build is
// promoted by merging forward: dev -> prod -> stable. Note the ordering --
// `stable` is the MOST conservative, not `prod`; prod is the soak stage that
// sits between them.
//
// Which channel a machine follows is a local choice, so it is not in git.
const CHANNELS = ['dev', 'prod', 'stable'];
const CHANNEL_HELP = {
  dev: 'every merge to the dev branch; expect breakage',
  prod: 'promoted from dev and soaking; broadly trustworthy',
  stable: 'promoted from prod after soaking; the most conservative',
};

function currentChannel() {
  try {
    const value = readFileSync(CHANNEL_FILE, 'utf8').trim();
    return CHANNELS.includes(value) ? value : 'stable';
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
  console.log('\n  promotion flows forward:  dev -> prod -> stable');
  for (const name of CHANNELS) {
    const mark = name === requested ? '*' : ' ';
    console.log(`   ${mark} ${name.padEnd(7)} ${CHANNEL_HELP[name]}`);
  }
}

const ok = (m) => console.log(`  \u001b[32mok\u001b[0m    ${m}`);
const warn = (m) => console.log(`  \u001b[33mwarn\u001b[0m  ${m}`);
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
  console.log('\nNext:');
  console.log('  ps-mcp auth      sign in to Google in a browser');
  console.log('  ps-mcp doctor    check everything is wired up');
  console.log('  then restart Claude Desktop.');
}

// --- auth ------------------------------------------------------------------

function auth() {
  const { paths } = loadBinaries(CONF);
  const gws = paths.get('gws');
  if (!gws) {
    bad('gws is not resolved. Run bin/ps-mcp-resolve first.');
    process.exitCode = 1;
    return;
  }
  console.log('Opening a browser to sign in to Google.');
  console.log('You authenticate as yourself; the token is stored encrypted in your home directory.\n');
  const r = spawnSync(gws, ['auth', 'login'], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}

// --- doctor ----------------------------------------------------------------

function gwsAuthState(gws) {
  try {
    const out = execFileSync(gws, ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
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
  ok(`channel: ${currentChannel()} (${CHANNEL_HELP[currentChannel()]})`);

  const gws = resolved.paths.get('gws');
  if (gws) {
    const state = gwsAuthState(gws);
    if (!state) warn('gws auth status could not be read');
    else if (state.credential_source && state.credential_source !== 'none') {
      ok(`Google: authenticated (${state.credential_source})`);
    } else {
      warn('Google: not signed in - run `ps-mcp auth`');
      if (!state.client_config_exists) {
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

  try {
    accessSync(LAUNCHER, constants.X_OK);
    ok('launcher is executable');
  } catch {
    bad('launcher is not executable');
    failures++;
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const COMMANDS = { setup, auth, doctor, channel, serve: () => spawnSync(LAUNCHER, { stdio: 'inherit' }) };
const command = process.argv[2];
if (!command || !COMMANDS[command]) {
  console.log('usage: ps-mcp <setup|auth|doctor|serve>');
  console.log('       ps-mcp channel [dev|prod|stable]');
  process.exitCode = command ? 1 : 0;
} else {
  COMMANDS[command]();
}
