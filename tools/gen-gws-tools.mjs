// Regenerate the gws service tools in etc/tools.yaml from the gws CLI itself.
//
// gws is uniform -- `gws <service> <resource> [sub] <method>` -- so the tools are
// derived, not hand-written. Keeping tool binaries current is an explicit goal,
// and a gws upgrade can add, rename or remove methods, so this has to be a
// re-run rather than an archaeology exercise. Only the region between the
// BEGIN/END GENERATED markers is touched; helpers and gws_schema are hand-written.
//
//   node tools/gen-gws-tools.mjs            regenerate in place
//   node tools/gen-gws-tools.mjs --check    fail if the manifest is out of date
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBinaries } from '../src/binaries.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(APP_DIR, 'etc', 'tools.yaml');
const BEGIN = '  # BEGIN GENERATED gws service tools -- regenerate with `npm run gen:gws`';
const END = '  # END GENERATED';

const GWS = loadBinaries(path.join(APP_DIR, 'etc', 'binaries.conf')).paths.get('gws');
if (!GWS) {
  console.error('gws is not resolved. Run bin/ps-mcp-resolve first.');
  process.exit(1);
}

// Services we expose, with the wording that goes into each tool description.
const SERVICES = [
  ['gmail', 'Gmail', 'messages, threads, drafts, labels, filters and mailbox settings'],
  ['calendar', 'Calendar', 'events, calendars, calendar list entries, ACLs and free/busy'],
  ['drive', 'Drive', 'files, folders, shared drives, permissions, comments and revisions'],
  ['sheets', 'Sheets', 'spreadsheets, values, and developer metadata'],
  ['docs', 'Docs', 'documents and their structured content'],
  ['slides', 'Slides', 'presentations, pages and page elements'],
  ['meet', 'Meet', 'conference records, participants, recordings and transcripts'],
  ['tasks', 'Tasks', 'task lists and tasks'],
  ['people', 'Contacts', 'contacts, contact groups and profile data (People API)'],
  ['chat', 'Chat', 'spaces, memberships, messages and reactions'],
  ['forms', 'Forms', 'forms, items and responses'],
  ['keep', 'Keep', 'notes, attachments and permissions'],
  ['admin-reports', 'Admin Reports', 'audit activity logs, usage reports and customer usage'],
];
// Admin Reports is inherently read-only; its only writes are watch/stop on
// subscriptions, which are not useful here.
const READ_ONLY_SERVICES = new Set(['admin-reports']);
const READ_EXACT = new Set(['list', 'search', 'batchGet', 'download', 'export']);
const DESTRUCTIVE = new Set(['delete', 'batchDelete', 'clear', 'remove']);
const isRead = (m) => m.startsWith('get') || READ_EXACT.has(m);

function children(argv) {
  let out;
  try {
    out = execFileSync(GWS, [...argv, '--help'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Commands:'));
  if (start === -1) return [];
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && line.trim()) break;      // next section
    // Exactly two spaces, then the name, then the gap before its description.
    // A wrapped description line is indented far deeper, aligned under the
    // description column -- matching {2,} swallowed those and turned words like
    // "Note" and "The" into bogus method names.
    const m = line.match(/^ {2}([+a-zA-Z][a-zA-Z-]*)(?: {2,}\S|\s*$)/);
    if (m && m[1] !== 'help') names.push(m[1]);
  }
  return names;
}

// Walk service -> resource -> [sub] -> method. A node is a sub-resource while it
// still has its own Commands: section.
function methodsFor(service) {
  const found = new Set();
  for (const resource of children([service])) {
    if (resource.startsWith('+')) continue;          // helper, hand-written
    const subs = children([service, resource]);
    if (subs.length === 0) continue;
    for (const sub of subs) {
      const grand = children([service, resource, sub]);
      if (grand.length === 0) found.add(sub);
      else for (const g of grand) found.add(g);
    }
  }
  return found;
}

const wrap = (text, indent) => {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && `${line} ${w}`.length > 74) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`).join('\n');
};

function toolBlock({ name, title, description, readOnly, destructive, service, verbs, withBody, timeoutMs }) {
  const values = [...verbs].sort().map((v) => `"${v}"`).join(', ');
  const out = [
    `  - name: ${name}`,
    '    type: exec',
    '    binary: gws',
    `    title: ${title}`,
    '    description: >-',
    wrap(description, '      '),
    `    timeoutMs: ${timeoutMs}`,
    '    hints:',
    `      readOnly: ${readOnly}`,
    `      destructive: ${destructive}`,
    '    output: json',
    '    params:',
    '      - name: resource',
    '        type: string',
    '        required: true',
    '        description: >-',
    '          First path segment after the service, e.g. "users" for Gmail,',
    '          "files" for Drive, "events" for Calendar. Use gws_schema to check.',
    '      - name: subresource',
    '        type: string',
    '        description: >-',
    '          Second path segment when the resource nests, e.g. "messages" in',
    '          `gmail users messages list`. Omit when there is none.',
    '      - name: detail',
    '        type: string',
    '        description: >-',
    '          Third path segment, only for deeply nested resources such as',
    '          `gmail users messages attachments get`. Rarely needed.',
    '      - name: method',
    '        type: enum',
    '        required: true',
    `        values: [${values}]`,
    '        description: The API method to call on that resource.',
    '      - name: params',
    '        type: string',
    '        description: >-',
    '          URL and query parameters as a JSON object string, e.g.',
    `          '{"userId": "me", "maxResults": 10}'. Most methods need at least an id.`,
  ];
  if (withBody) {
    out.push(
      '      - name: body',
      '        type: string',
      '        description: >-',
      '          Request body as a JSON object string, for methods that take one',
      '          (create, update, patch, send).',
    );
  }
  out.push(
    '    argv:',
    `      - "${service}"`,
    '      - "{{resource}}"',
    '      - "{{subresource}}"',
    '      - "{{detail}}"',
    '      - "{{method}}"',
    '      - ["--params", "{{params}}"]',
  );
  if (withBody) out.push('      - ["--json", "{{body}}"]');
  out.push('      - "--format"', '      - "json"', '');
  return out.join('\n');
}

const version = execFileSync(GWS, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
const blocks = [];
let methodCount = 0;
for (const [service, label, what] of SERVICES) {
  const all = methodsFor(service);
  if (all.size === 0) {
    console.error(`  note: ${service} exposed no methods; skipping`);
    continue;
  }
  methodCount += all.size;
  const reads = new Set([...all].filter(isRead));
  const writes = READ_ONLY_SERVICES.has(service) ? new Set() : new Set([...all].filter((m) => !isRead(m)));
  const id = service.replace(/-/g, '_');
  if (reads.size) {
    blocks.push(toolBlock({
      name: `${id}_read`, title: `Read ${label}`,
      description: `Read-only ${label} API calls: ${what}. Never modifies anything. Pass parameters as a JSON string in \`params\`; use gws_schema for the exact parameter names.`,
      readOnly: true, destructive: false, service, verbs: reads, withBody: false, timeoutMs: 60000,
    }));
  }
  if (writes.size) {
    const destructive = [...writes].some((m) => DESTRUCTIVE.has(m));
    blocks.push(toolBlock({
      name: `${id}_write`, title: `Write ${label}`,
      description: `Mutating ${label} API calls: ${what}. ${destructive ? 'Includes delete methods, which permanently remove data.' : 'Creates and updates data.'} Pass parameters as JSON in \`params\` and the request body as JSON in \`body\`. Use gws_schema to check what a method expects.`,
      readOnly: false, destructive, service, verbs: writes, withBody: true, timeoutMs: 60000,
    }));
  }
}

const header = [
  '  # --- Google Workspace (gws) ----------------------------------------------',
  `  # Generated against ${version}: ${methodCount} methods across ${SERVICES.length} services.`,
  '  # Each service gets a read tool and a write tool so readOnly/destructive',
  '  # hints stay honest; together they reach the whole API. gws_schema lets the',
  '  # model look up the exact parameters for any method.',
  '',
  '',
].join('\n');

const current = readFileSync(MANIFEST, 'utf8');
const begin = current.indexOf(BEGIN);
const end = current.indexOf(END);
if (begin === -1 || end === -1) {
  console.error('BEGIN/END GENERATED markers not found in etc/tools.yaml');
  process.exit(1);
}
const next = `${current.slice(0, begin)}${BEGIN}\n${header}${blocks.join('\n')}${current.slice(end)}`;

if (process.argv.includes('--check')) {
  if (next === current) {
    console.log(`up to date against ${version} (${blocks.length} tools)`);
  } else {
    console.error(`etc/tools.yaml is out of date against ${version}. Run: npm run gen:gws`);
    process.exit(1);
  }
} else {
  writeFileSync(MANIFEST, next);
  console.log(`wrote ${blocks.length} gws tools from ${version} (${methodCount} methods)`);
}
