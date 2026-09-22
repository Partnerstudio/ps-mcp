import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assetUrl, extractAuthUrl, psMcpProjects, withPsMcp, withoutPsMcp } from '../src/cli.js';

// gws prints its consent URL to stdout and then waits on a loopback port. If we
// fail to spot it, the user sees a hung command and no browser.
describe('extractAuthUrl', () => {
  const REAL = 'https://accounts.google.com/o/oauth2/auth?scope=https://www.googleapis.com/auth/drive%20openid&access_type=offline&redirect_uri=http://localhost:64543&response_type=code&client_id=000000000000-example.apps.googleusercontent.com&prompt=select_account+consent';

  it('finds the URL in gws output', () => {
    assert.equal(extractAuthUrl(`Open this URL in your browser to authenticate:\n\n  ${REAL}\n`), REAL);
  });

  it('keeps the whole query string, including the redirect port', () => {
    const url = extractAuthUrl(`  ${REAL}\n`);
    assert.match(url, /localhost:64543/);
    assert.match(url, /prompt=select_account\+consent/);
  });

  it('returns null when there is no URL yet', () => {
    assert.equal(extractAuthUrl('Using keyring backend: file\n'), null);
  });

  // The match runs against everything seen so far, so a split chunk still works
  // once the terminating newline arrives with the rest.
  it('finds a URL assembled from two chunks', () => {
    const half = Math.floor(REAL.length / 2);
    let seen = `blah\n${REAL.slice(0, half)}`;
    assert.equal(extractAuthUrl(seen), null, 'a partial URL must not match');
    seen += REAL.slice(half);
    assert.equal(extractAuthUrl(seen), REAL, 'complete once the second chunk lands');
  });

  // The property that actually matters: gws writes nothing after the URL until
  // the browser callback returns, so a complete URL with NO trailing newline
  // must still match -- otherwise we never open the browser in time.
  it('matches a complete URL that has no trailing newline yet', () => {
    assert.equal(extractAuthUrl(`Open this URL:\n\n  ${REAL}`), REAL);
  });

  it('rejects a truncated URL, which would open a broken consent page', () => {
    assert.equal(extractAuthUrl(REAL.slice(0, Math.floor(REAL.length / 2))), null);
    assert.equal(extractAuthUrl(REAL.slice(0, REAL.indexOf('client_id='))), null);
  });
});

describe('assetUrl', () => {
  // The asset name comes from version.json rather than being constructed, so
  // the naming scheme can change server-side without stranding older clients.
  it('builds the URL from the name the index gives', () => {
    const url = assetUrl('stable', { asset: 'ps-mcp-0.2.0-stable.abc1234.tar.gz' });
    assert.match(url, /release-stable\/ps-mcp-0\.2\.0-stable\.abc1234\.tar\.gz$/);
  });

  it('honours a release base override', () => {
    const old = process.env.PS_MCP_RELEASE_BASE;
    try {
      assert.match(assetUrl('dev', { asset: 'x.tar.gz' }), /releases\/download\/release-dev\/x\.tar\.gz$/);
    } finally {
      if (old === undefined) delete process.env.PS_MCP_RELEASE_BASE;
    }
  });
});

// ~/.claude.json is 200 KB of Claude Code's own state -- startup counters,
// cached feature flags, and every other MCP server the user has. We merge one
// key into one project entry. Dropping any of the rest would be silent and
// expensive.
describe('withPsMcp', () => {
  const DIR = '/Users/x/dev/bizdev';
  const existing = {
    numStartups: 412,
    mcpServers: { railway: { command: '/usr/local/bin/railway' } },
    projects: {
      '/Users/x/other': { hasTrustDialogAccepted: true, mcpServers: { cve: { command: '/x/cve' } } },
    },
  };

  it('registers only under the project directory, never globally', () => {
    const next = withPsMcp(existing, '/opt/ps-mcp/launcher/ps-mcp-launch', DIR);
    assert.equal(next.mcpServers['ps-mcp'], undefined, 'a global entry would load the tools everywhere');
    assert.equal(next.projects[DIR].mcpServers['ps-mcp'].command, '/opt/ps-mcp/launcher/ps-mcp-launch');
  });

  it('leaves every other key and every other project alone', () => {
    const next = withPsMcp(existing, '/x/ps-mcp-launch', DIR);
    assert.equal(next.numStartups, 412);
    assert.deepEqual(next.mcpServers.railway, { command: '/usr/local/bin/railway' });
    assert.deepEqual(next.projects['/Users/x/other'].mcpServers, { cve: { command: '/x/cve' } });
    assert.equal(next.projects['/Users/x/other'].hasTrustDialogAccepted, true);
  });

  it('keeps the rest of an entry when the directory is already known', () => {
    const known = { projects: { [DIR]: { lastCost: 1.5, mcpServers: { other: { command: '/o' } } } } };
    const next = withPsMcp(known, '/x/ps-mcp-launch', DIR);
    assert.equal(next.projects[DIR].lastCost, 1.5);
    assert.deepEqual(next.projects[DIR].mcpServers.other, { command: '/o' });
  });

  it('does not mutate the config it was given', () => {
    const before = JSON.stringify(existing);
    withPsMcp(existing, '/somewhere/ps-mcp-launch', DIR);
    assert.equal(JSON.stringify(existing), before);
  });

  it('replaces a stale path from an earlier install', () => {
    const stale = { projects: { [DIR]: { mcpServers: { 'ps-mcp': { command: '/old/ps-mcp-launch' } } } } };
    const next = withPsMcp(stale, '/new/ps-mcp-launch', DIR);
    assert.equal(next.projects[DIR].mcpServers['ps-mcp'].command, '/new/ps-mcp-launch');
  });
});

describe('withoutPsMcp and psMcpProjects', () => {
  const DIR = '/Users/x/dev/bizdev';

  it('removes only our entry, leaving the directory and its other servers', () => {
    const config = withPsMcp({ projects: { [DIR]: { lastCost: 2, mcpServers: { other: { command: '/o' } } } } }, '/l', DIR);
    const next = withoutPsMcp(config, DIR);
    assert.equal(next.projects[DIR].mcpServers['ps-mcp'], undefined);
    assert.deepEqual(next.projects[DIR].mcpServers.other, { command: '/o' });
    assert.equal(next.projects[DIR].lastCost, 2);
  });

  it('is a no-op for a directory that never had it', () => {
    const config = { projects: { [DIR]: { mcpServers: {} } } };
    assert.equal(withoutPsMcp(config, DIR), config, 'same object, so nothing is rewritten');
  });

  it('lists the directories where ps-mcp is enabled, and no others', () => {
    let config = { projects: { '/a': { mcpServers: { x: {} } } } };
    config = withPsMcp(config, '/l', '/b');
    config = withPsMcp(config, '/l', '/c');
    assert.deepEqual(psMcpProjects(config), ['/b', '/c']);
  });
});
