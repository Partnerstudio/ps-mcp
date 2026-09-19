import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { parseManifest } from '../src/manifest.js';
import { ToolInputError } from '../src/args.js';
import { runSdkTool } from '../src/sdk-tool.js';

const MANIFEST = `
version: 1
s3:
  region: eu-north-1
tools:
  - name: demo_sdk
    type: sdk
    title: Demo
    description: A demo sdk tool.
    hints: { readOnly: true, destructive: false }
    params:
      - name: bucket
        type: string
        required: true
        description: Bucket name.
      - name: path
        type: string
        path: true
        description: A local file.
      - name: count
        type: integer
        description: Optional count.
`;

const [tool] = parseManifest(MANIFEST, { file: 't.yaml' }).tools;
let root;

before(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ps-mcp-sdk-')));
  mkdirSync(path.join(root, 'clips'), { recursive: true });
  writeFileSync(path.join(root, 'clips', 'promo.mov'), 'x');
});

const run = (args, handler) =>
  runSdkTool(tool, args, { root, handlers: { demo_sdk: handler } });

describe('runSdkTool', () => {
  it('passes typed values to the handler and returns JSON', async () => {
    const result = await run({ bucket: 'b', count: 3 }, async (v) => ({ seen: v }));
    assert.equal(result.isError, false);
    const parsed = JSON.parse(result.content[0].text);
    // the integer must stay an integer, unlike the exec runner which stringifies
    assert.equal(parsed.seen.count, 3);
    assert.equal(parsed.seen.bucket, 'b');
  });

  it('canonicalises a path param before the handler sees it', async () => {
    const result = await run({ bucket: 'b', path: 'clips/promo.mov' }, async (v) => ({ p: v.path }));
    assert.equal(JSON.parse(result.content[0].text).p, path.join(root, 'clips', 'promo.mov'));
  });

  it('omits optional params that were not supplied', async () => {
    const result = await run({ bucket: 'b' }, async (v) => ({ keys: Object.keys(v) }));
    assert.deepEqual(JSON.parse(result.content[0].text).keys, ['bucket']);
  });

  it('rejects a path escaping the work root before calling the handler', async () => {
    let called = false;
    const result = await run({ bucket: 'b', path: '../../etc/passwd' }, async () => {
      called = true;
      return {};
    });
    assert.equal(result.isError, true);
    assert.equal(called, false, 'handler must not run on bad input');
    assert.match(result.content[0].text, /outside the work root/);
  });

  it('rejects an unknown argument', async () => {
    const result = await run({ bucket: 'b', nope: 1 }, async () => ({}));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unknown argument `nope`/);
  });

  it('turns a handler ToolInputError into a tool error, not a crash', async () => {
    const result = await run({ bucket: 'b' }, async () => {
      throw new ToolInputError('destination already exists: /tmp/x');
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /destination already exists/);
  });

  it('formats an AWS SDK error with its name and HTTP status', async () => {
    const result = await run({ bucket: 'b' }, async () => {
      const err = new Error('Access Denied');
      err.name = 'AccessDenied';
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'AccessDenied (HTTP 403): Access Denied');
  });

  it('throws if no handler is registered for the tool', async () => {
    await assert.rejects(
      () => runSdkTool(tool, { bucket: 'b' }, { root, handlers: {} }),
      /no sdk handler registered/,
    );
  });
});
