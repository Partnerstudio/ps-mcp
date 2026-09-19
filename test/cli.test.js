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
    seen += `${REAL.slice(half)}\n`;
    assert.equal(extractAuthUrl(seen), REAL);
  });

  // The safety property: opening a truncated consent URL sends the user to a
  // broken page, so an unterminated URL is treated as not yet complete.
  it('does not match a URL that has no terminator yet', () => {
    assert.equal(extractAuthUrl(REAL.slice(0, -20)), null);
    assert.equal(extractAuthUrl(REAL), null, 'no trailing whitespace means not proven complete');
    assert.equal(extractAuthUrl(`${REAL}\n`), REAL);
  });
});
