import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parseManifest } from '../src/manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = path.join(here, '..', 'etc', 'tools.yaml');

const VALID = `
version: 1
binaries:
  echo: /bin/echo
tools:
  - name: demo
    type: exec
    binary: echo
    title: Demo
    description: A demo tool.
    hints: { readOnly: true, destructive: false }
    params:
      - name: path
        type: string
        required: true
        path: true
        description: A path.
      - name: mode
        type: enum
        values: [fast, slow]
        description: How fast.
    argv: ["{{path}}", "--mode={{mode}}"]
`;

const broken = (yaml) => {
  try {
    parseManifest(yaml, { file: 't.yaml' });
    assert.fail('expected the manifest to be rejected');
  } catch (err) {
    assert.equal(err.name, 'ManifestError', `expected ManifestError, got ${err}`);
    return err.message;
  }
};

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const { tools } = parseManifest(VALID, { file: 't.yaml' });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].binaryPath, '/bin/echo');
    assert.equal(tools[0].timeoutMs, 30_000);
    assert.equal(tools[0].output, 'text');
  });

  it('builds an inputSchema the client can validate against', () => {
    const [tool] = parseManifest(VALID, { file: 't.yaml' }).tools;
    assert.deepEqual(tool.inputSchema.required, ['path']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.mode.type, 'string');
    assert.deepEqual(tool.inputSchema.properties.mode.enum, ['fast', 'slow']);
    assert.match(tool.inputSchema.properties.path.description, /work root/);
  });

  it('rejects an unknown version', () => {
    assert.match(broken(VALID.replace('version: 1', 'version: 2')), /`version` must be 1/);
  });

  it('rejects an argv placeholder with no matching param', () => {
    assert.match(broken(VALID.replace('{{path}}', '{{nope}}')), /undeclared param `nope`/);
  });

  it('rejects a param that argv never references', () => {
    assert.match(broken(VALID.replace('"--mode={{mode}}"', '"--mode=fast"')), /never referenced in argv/);
  });

  it('requires both tool hints', () => {
    assert.match(
      broken(VALID.replace('hints: { readOnly: true, destructive: false }', 'hints: { readOnly: true }')),
      /hints\.readOnly` and `hints\.destructive`/,
    );
  });

  it('rejects `path: true` on a non-string param', () => {
    assert.match(
      broken(VALID.replace('        type: string\n        required: true\n        path: true', '        type: integer\n        required: true\n        path: true')),
      /only valid on type string/,
    );
  });

  it('rejects a binary that is not declared', () => {
    assert.match(broken(VALID.replace('binary: echo', 'binary: ffmpeg')), /must name a key in top-level/);
  });

  it('rejects a relative binary path', () => {
    assert.match(broken(VALID.replace('echo: /bin/echo', 'echo: echo')), /must be an absolute path/);
  });

  it('rejects duplicate tool names', () => {
    const doubled = `${VALID}
  - name: demo
    type: exec
    binary: echo
    title: Demo again
    description: Same name.
    hints: { readOnly: true, destructive: false }
    argv: ["hi"]
`;
    assert.match(broken(doubled), /duplicate tool name/);
  });

  it('accepts the manifest that actually ships', () => {
    const { tools } = parseManifest(readFileSync(SHIPPED, 'utf8'), { file: SHIPPED });
    const probe = tools.find((t) => t.name === 'ffprobe_info');
    assert.ok(probe, 'ffprobe_info should be declared');
    assert.equal(probe.output, 'json');
    assert.equal(probe.hints.readOnly, true);
    assert.equal(probe.hints.destructive, false);
    assert.deepEqual(probe.inputSchema.required, ['path']);
  });
});
