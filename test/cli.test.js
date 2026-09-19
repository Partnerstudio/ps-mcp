import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractAuthUrl } from '../src/cli.js';

// gws prints its consent URL to stdout and then waits on a loopback port. If we
// fail to spot it, the user sees a hung command and no browser.
describe('extractAuthUrl', () => {
  const REAL = 'https://accounts.google.com/o/oauth2/auth?scope=https://www.googleapis.com/auth/drive%20openid&access_type=offline&redirect_uri=http://localhost:64543&response_type=code&client_id=687984483964-x.apps.googleusercontent.com&prompt=select_account+consent';

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
