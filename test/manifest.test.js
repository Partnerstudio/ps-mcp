import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parseManifest } from '../src/manifest.js';
import { S3_TOOL_NAMES } from '../src/s3-tools.js';

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

const VALID_SDK = `
version: 1
s3:
  region: eu-north-1
tools:
  - name: s3_list
    type: sdk
    title: List
    description: Lists things.
    hints: { readOnly: true, destructive: false }
    params:
      - name: bucket
        type: string
        required: true
        description: Bucket name.
`;

describe('parseManifest, sdk tools', () => {
  it('parses an sdk tool and forces json output', () => {
    const [tool] = parseManifest(VALID_SDK, { file: 't.yaml' }).tools;
    assert.equal(tool.type, 'sdk');
    assert.equal(tool.output, 'json');
    assert.equal(tool.binaryPath, undefined);
    assert.deepEqual(tool.inputSchema.required, ['bucket']);
  });

  it('reads the s3 config block with a default presign cap', () => {
    const { s3 } = parseManifest(VALID_SDK, { file: 't.yaml' });
    assert.equal(s3.region, 'eu-north-1');
    assert.equal(s3.presignMaxSeconds, 86_400);
  });

  it('requires an s3 block when any sdk tool is declared', () => {
    const noS3 = VALID_SDK.replace('s3:\n  region: eu-north-1\n', '');
    assert.match(broken(noS3), /`s3` is required when any sdk tool is declared/);
  });

  it('rejects a presign cap above the SigV4 maximum', () => {
    const tooLong = VALID_SDK.replace('  region: eu-north-1', '  region: eu-north-1\n  presignMaxSeconds: 604801');
    assert.match(broken(tooLong), /no greater than 604800/);
  });

  for (const key of ['binary', 'argv', 'output']) {
    it(`rejects \`${key}\` on an sdk tool`, () => {
      const withKey = VALID_SDK.replace(
        '    title: List',
        key === 'argv' ? '    argv: ["x"]\n    title: List' : `    ${key}: x\n    title: List`,
      );
      assert.match(broken(withKey), new RegExp(`\\\`${key}\\\` is not valid on a`));
    });
  }

  it('rejects an sdk tool with no registered handler', () => {
    const unknown = VALID_SDK.replace('name: s3_list', 'name: s3_nope');
    try {
      parseManifest(unknown, { file: 't.yaml', sdkHandlers: new Set(['s3_list']) });
      assert.fail('expected rejection');
    } catch (err) {
      assert.match(err.message, /no sdk handler is registered for `s3_nope`/);
    }
  });

  it('accepts the shipped manifest against the real handler registry', () => {
    const { tools, s3 } = parseManifest(readFileSync(SHIPPED, 'utf8'), {
      file: SHIPPED,
      sdkHandlers: new Set(S3_TOOL_NAMES),
    });
    const names = tools.map((t) => t.name);
    for (const expected of S3_TOOL_NAMES) assert.ok(names.includes(expected), `${expected} missing`);
    assert.equal(s3.presignMaxSeconds, 86_400);
    // the only destructive tool must be the delete
    const destructive = tools.filter((t) => t.hints.destructive).map((t) => t.name);
    assert.deepEqual(destructive, ['s3_delete']);
  });
});
