import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { parseManifest } from '../src/manifest.js';
import { ToolInputError, bindArgs } from '../src/args.js';
import { renderArgv, runExecTool } from '../src/exec-tool.js';

const MANIFEST = `
version: 1
binaries:
  echo: /bin/echo
tools:
  - name: demo
    type: exec
    binary: echo
    title: Demo
    description: A demo tool.
    timeoutMs: 5000
    hints: { readOnly: true, destructive: false }
    params:
      - name: path
        type: string
        required: true
        path: true
        description: A path.
      - name: label
        type: string
        description: Optional label.
      - name: count
        type: integer
        description: Optional count.
    argv: ["{{path}}", "--label={{label}}", "-n", "{{count}}"]
`;

const [tool] = parseManifest(MANIFEST, { file: 't.yaml' }).tools;
let root;

before(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ps-mcp-exec-')));
  mkdirSync(path.join(root, 'clips'), { recursive: true });
  writeFileSync(path.join(root, 'clips', 'promo.mov'), 'x');
});

describe('bindArgs', () => {
  const bad = (args) => {
    try {
      bindArgs(tool, args, { root });
      assert.fail('expected ToolInputError');
    } catch (err) {
      assert.ok(err instanceof ToolInputError, `expected ToolInputError, got ${err}`);
      return err.message;
    }
  };

  it('resolves a path param to its canonical location', () => {
    const values = bindArgs(tool, { path: 'clips/promo.mov' }, { root });
    assert.equal(values.path, path.join(root, 'clips', 'promo.mov'));
  });

  it('rejects a missing required argument', () => {
    assert.match(bad({}), /missing required argument `path`/);
  });

  it('rejects an unknown argument', () => {
    assert.match(bad({ path: 'clips/promo.mov', bogus: 1 }), /unknown argument `bogus`/);
  });

  it('rejects a wrong type', () => {
    assert.match(bad({ path: 'clips/promo.mov', count: 1.5 }), /`count` must be integer/);
  });

  // The client is told the schema, but the arguments come from a model.
  it('rejects a path escaping the work root', () => {
    assert.match(bad({ path: '../../etc/passwd' }), /outside the work root/);
  });

  it('rejects a hidden path', () => {
    assert.match(bad({ path: '.ssh/id_rsa' }), /hidden entry/);
  });
});

describe('renderArgv', () => {
  it('drops tokens whose params were not supplied', () => {
    const argv = renderArgv(tool, bindArgs(tool, { path: 'clips/promo.mov' }, { root }));
    assert.deepEqual(argv, [path.join(root, 'clips', 'promo.mov'), '-n']);
  });

  it('interpolates inside a token without splitting it', () => {
    const argv = renderArgv(tool, bindArgs(tool, { path: 'clips/promo.mov', label: 'a b c' }, { root }));
    assert.deepEqual(argv, [path.join(root, 'clips', 'promo.mov'), '--label=a b c', '-n']);
  });

  it('keeps a numeric token as one argument', () => {
    const argv = renderArgv(tool, bindArgs(tool, { path: 'clips/promo.mov', count: 3 }, { root }));
    assert.deepEqual(argv, [path.join(root, 'clips', 'promo.mov'), '-n', '3']);
  });
});

describe('renderArgv, groups', () => {
  const GROUPED = `
version: 1
binaries:
  echo: /bin/echo
tools:
  - name: grouped
    type: exec
    binary: echo
    title: Grouped
    description: Optional flag pairs.
    hints: { readOnly: true, destructive: false }
    params:
      - name: resource
        type: string
        required: true
        description: Resource.
      - name: params
        type: string
        description: Optional JSON params.
      - name: body
        type: string
        description: Optional JSON body.
    argv:
      - "{{resource}}"
      - ["--params", "{{params}}"]
      - ["--json", "{{body}}"]
`;
  const [grouped] = parseManifest(GROUPED, { file: 't.yaml' }).tools;

  it('normalizes a bare string into a group of one', () => {
    assert.deepEqual(grouped.argv[0], ['{{resource}}']);
  });

  // The point of groups: a dangling --params with no value would break the CLI.
  it('drops the whole flag pair when the value is absent', () => {
    const argv = renderArgv(grouped, { resource: 'users' });
    assert.deepEqual(argv, ['users']);
  });

  it('emits both tokens of a pair when the value is supplied', () => {
    const argv = renderArgv(grouped, { resource: 'users', params: '{"a":1}' });
    assert.deepEqual(argv, ['users', '--params', '{"a":1}']);
  });

  it('keeps JSON with spaces and quotes as one argv element', () => {
    const json = '{"q": "from:me subject:\'x y\'"}';
    const argv = renderArgv(grouped, { resource: 'users', params: json });
    assert.equal(argv.length, 3);
    assert.equal(argv[2], json);
  });

  it('resolves each pair independently', () => {
    const argv = renderArgv(grouped, { resource: 'users', body: '{"b":2}' });
    assert.deepEqual(argv, ['users', '--json', '{"b":2}']);
  });

  it('rejects an argv entry that is neither string nor list of strings', () => {
    const bad = GROUPED.replace('      - "{{resource}}"', '      - 42');
    assert.throws(() => parseManifest(bad, { file: 't.yaml' }), /must be a string or a non-empty list of strings/);
  });
});

describe('runExecTool', () => {
  it('runs the binary and returns its output', async () => {
    const result = await runExecTool(tool, { path: 'clips/promo.mov', label: 'hi' }, { root });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /--label=hi/);
  });

  it('returns a tool error rather than throwing on bad input', async () => {
    const result = await runExecTool(tool, { path: '../escape' }, { root });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside the work root/);
  });

  it('reports a non-zero exit as a tool error', async () => {
    const failing = { ...tool, binaryPath: '/usr/bin/false', binaryName: 'false' };
    const result = await runExecTool(failing, { path: 'clips/promo.mov' }, { root });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exited with code 1/);
  });

  it('reports a timeout as a tool error', async () => {
    const slow = { ...tool, binaryPath: '/bin/sleep', binaryName: 'sleep', timeoutMs: 120, argv: [['5']], params: [] };
    const result = await runExecTool(slow, {}, { root });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out after 120 ms/);
  });
});
