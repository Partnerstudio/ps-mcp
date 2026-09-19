import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PathDenied, resolveWorkPath } from '../src/paths.js';

let root;
let outside;

before(() => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ps-mcp-paths-')));
  root = path.join(base, 'work');
  outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'clips'), { recursive: true });
  mkdirSync(path.join(root, '.ssh'), { recursive: true });
  mkdirSync(path.join(root, 'Library', 'Keychains'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'clips', 'promo.mov'), 'x');
  writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'secret');
  writeFileSync(path.join(root, 'Library', 'Keychains', 'login.keychain'), 'secret');
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
  symlinkSync(path.join(root, '.ssh'), path.join(root, 'clips', 'keys'));
});

const denied = (requested) => {
  try {
    const resolved = resolveWorkPath(requested, { root });
    assert.fail(`expected PathDenied, got ${resolved}`);
  } catch (err) {
    assert.ok(err instanceof PathDenied, `expected PathDenied, got ${err}`);
    return err.reason;
  }
};

describe('resolveWorkPath', () => {
  it('resolves a path relative to the work root', () => {
    assert.equal(resolveWorkPath('clips/promo.mov', { root }), path.join(root, 'clips', 'promo.mov'));
  });

  it('accepts an absolute path inside the root', () => {
    const abs = path.join(root, 'clips', 'promo.mov');
    assert.equal(resolveWorkPath(abs, { root }), abs);
  });

  it('allows a file that does not exist yet, under an existing directory', () => {
    assert.equal(resolveWorkPath('clips/out.mp4', { root }), path.join(root, 'clips', 'out.mp4'));
  });

  it('rejects .. traversal out of the root', () => {
    assert.equal(denied('../outside/secret.txt'), 'outside-root');
  });

  it('rejects an absolute path outside the root', () => {
    assert.equal(denied(path.join(outside, 'secret.txt')), 'outside-root');
  });

  it('rejects a hidden directory', () => {
    assert.equal(denied('.ssh/id_rsa'), 'hidden');
  });

  it('rejects a hidden file at the root', () => {
    assert.equal(denied('.env'), 'hidden');
  });

  it('rejects the excluded Library subtree', () => {
    assert.equal(denied('Library/Keychains/login.keychain'), 'excluded');
  });

  // The important one: the string looks contained, the target is not.
  it('rejects a symlink that escapes the root', () => {
    assert.equal(denied('escape.txt'), 'outside-root');
  });

  it('rejects a symlink into a hidden directory inside the root', () => {
    assert.equal(denied('clips/keys/id_rsa'), 'hidden');
  });

  // node --permission refuses to stat anything the launcher did not grant, which
  // is every path outside the work root. That must read as a containment
  // rejection, not an internal error.
  it('rejects an unstattable path outside the root without throwing', () => {
    const walled = path.join(outside, 'walled');
    mkdirSync(walled, { recursive: true });
    writeFileSync(path.join(walled, 'secret.txt'), 'secret');
    chmodSync(walled, 0o000);
    try {
      assert.equal(denied(path.join(walled, 'secret.txt')), 'outside-root');
    } finally {
      chmodSync(walled, 0o700);
    }
  });

  it('rejects an empty path', () => {
    assert.equal(denied(''), 'empty');
    assert.equal(denied('   '), 'empty');
  });
});
