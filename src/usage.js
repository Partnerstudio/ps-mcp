// Token usage ledger. Reads the transcripts the AI clients already write and
// records what they cost, in tokens, per model and per tool.
//
// None of this runs inside the MCP server. Collection happens in the CLI, which
// is outside the Seatbelt sandbox, so the server never reads a transcript and
// the profile does not have to open up to make this work.
//
// Design: docs/specs/2026-09-21-token-usage-design.md
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const LEDGER = process.env.PS_MCP_USAGE_FILE
  ?? path.join(homedir(), '.config', 'ps-mcp', 'usage', 'tokens.jsonl');

// --- domains -----------------------------------------------------------------

const DOMAIN_BY_PREFIX = [
  ['gmail_', 'Mail'], ['calendar_', 'Calendar'], ['docs_', 'Docs'],
  ['sheets_', 'Sheets'], ['slides_', 'Slides'], ['drive_', 'Drive'],
  ['s3_', 'Storage'], ['ffprobe_', 'Media'],
];

// Returns the domain a ps-mcp tool belongs to, or null for a tool that is not
// ours (the client's own Bash, Read and so on).
//
// `workflow_*` deliberately gets a line of its own rather than a domain:
// workflow_meeting_prep touches calendar, docs and mail in one call, so filing
// it under any one of them would make three totals wrong in a way no reader
// could see.
export function domainOf(tool) {
  if (tool === 'gws_schema') return 'Discovery';
  if (tool.startsWith('workflow_')) return tool;
  const hit = DOMAIN_BY_PREFIX.find(([prefix]) => tool.startsWith(prefix));
  return hit ? hit[1] : null;
}

// --- parsers -----------------------------------------------------------------

const toolNames = (content) => (Array.isArray(content) ? content : [])
  .filter((b) => b && b.type === 'tool_use' && b.name)
  .map((b) => b.name);

const emptySkips = () => ({ parse: 0, shape: 0, iterations: 0, mismatch: 0 });

export function parseClaudeCode(text, { file = '' } = {}) {
  const records = [];
  const skipped = emptySkips();
  text.split('\n').forEach((line, idx) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { skipped.parse++; return; }
    const m = o.message;
    if (!m || typeof m !== 'object' || !m.usage) return;
    const u = m.usage;
    // message.id is the API's own response id, and our deduplication key.
    // Without it a re-read is indistinguishable from a new turn.
    if (!m.id) { skipped.shape++; return; }
    // `iterations` repeats the same counts, so the top-level figure is the one
    // to use. Measured over 1,070 messages none had more than one entry; where
    // one does, count it rather than assume the relationship still holds.
    if (Array.isArray(u.iterations) && u.iterations.length > 1) skipped.iterations++;
    records.push({
      ts: o.timestamp ?? null,
      source: 'claude-code',
      session: o.sessionId ?? path.basename(file, '.jsonl'),
      seq: idx,
      id: m.id,
      model: m.model ?? null,
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cache_write: u.cache_creation_input_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      tools: toolNames(m.content),
      extra: {
        cache_write_5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
        cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? 0,
        sidechain: o.isSidechain === true,
      },
    });
  });
  return { records, skipped };
}

export function parseCodex(text) {
  const records = [];
  const skipped = emptySkips();
  let session = null;
  let model = null;
  let pending = [];          // tool calls seen since the last token_count
  let finalTotal = null;
  const summed = { in: 0, out: 0 };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { skipped.parse++; continue; }
    const p = o.payload ?? {};

    if (o.type === 'session_meta') { session = p.session_id ?? session; continue; }
    // The model lives in turn_context, not in the usage event, and a session
    // can switch models part way through. Attribute to the most recent one.
    if (o.type === 'turn_context') { model = p.model ?? model; continue; }
    if (o.type === 'response_item') {
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.name) pending.push(p.name);
      continue;
    }
    if (o.type !== 'event_msg' || p.type !== 'token_count') continue;

    const info = p.info ?? {};
    finalTotal = info.total_token_usage ?? finalTotal;
    // total_token_usage is cumulative for the session; last_token_usage is this
    // turn. Summing the cumulative one inflates a session quadratically.
    const lt = info.last_token_usage;
    if (!lt) { skipped.shape++; continue; }

    const cacheRead = lt.cached_input_tokens ?? 0;
    const cacheWrite = lt.cache_write_input_tokens ?? 0;
    // The two sources disagree about what `input_tokens` means. Codex reports
    // the TOTAL input, with the cached and cache-written parts as subsets of
    // it; Anthropic reports the fresh remainder, disjoint from the other two.
    // Subtracting here makes `in + cache_write + cache_read` the context size
    // on either source. Verified non-negative across 276 real events, but
    // clamped because a negative would silently corrupt every later figure.
    const fresh = Math.max(0, (lt.input_tokens ?? 0) - cacheRead - cacheWrite);
    summed.in += lt.input_tokens ?? 0;
    summed.out += lt.output_tokens ?? 0;

    records.push({
      ts: o.timestamp ?? null,
      source: 'codex',
      session,
      seq: o.ordinal ?? records.length,
      id: `${session}:${o.ordinal}`,
      model,
      in: fresh,
      out: lt.output_tokens ?? 0,
      cache_write: cacheWrite,
      cache_read: cacheRead,
      tools: pending,
      extra: { reasoning: lt.reasoning_output_tokens ?? 0 },
    });
    pending = [];
  }

  // The deltas must add up to the cumulative figure the session itself reports.
  // If they do not, one of the two is being read wrongly and neither should be
  // quietly believed.
  if (finalTotal && records.length) {
    const drift = (finalTotal.input_tokens ?? 0) !== summed.in
      || (finalTotal.output_tokens ?? 0) !== summed.out;
    if (drift) skipped.mismatch++;
  }
  return { records, skipped };
}

// --- collection --------------------------------------------------------------

function jsonlUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export function collect({ claudeDir, codexDir } = {}) {
  const roots = [
    [claudeDir ?? path.join(homedir(), '.claude', 'projects'), parseClaudeCode],
    [codexDir ?? path.join(homedir(), '.codex', 'sessions'), parseCodex],
  ];
  const records = [];
  const skipped = { ...emptySkips(), unreadable: [] };
  for (const [root, parse] of roots) {
    for (const file of jsonlUnder(root)) {
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { skipped.unreadable.push(file); continue; }
      const got = parse(text, { file });
      records.push(...got.records);
      for (const k of ['parse', 'shape', 'iterations', 'mismatch']) skipped[k] += got.skipped[k];
    }
  }
  return { records, skipped };
}

// --- ledger ------------------------------------------------------------------

const keyOf = (r) => `${r.source}:${r.id}`;

export function readLedger(file = LEDGER) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    // A torn final line from an interrupted write is dropped; the record it
    // held is re-collected from the transcript on the next run.
    try { out.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return out;
}

// Returns only the records not already present. Deduplication is what makes a
// concurrent or repeated run harmless, so it is done on read, not on write.
export function newRecords(existing, incoming) {
  const seen = new Set(existing.map(keyOf));
  const added = [];
  for (const r of incoming) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    added.push(r);
  }
  return added;
}

export function appendLedger(records, file = LEDGER) {
  if (!records.length) return 0;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return records.length;
}

// --- aggregation -------------------------------------------------------------

const contextOf = (r) => r.in + r.cache_write + r.cache_read;

export function since(records, day) {
  if (!day) return records;
  return records.filter((r) => typeof r.ts === 'string' && r.ts.slice(0, 10) >= day);
}

export function aggregate(records) {
  const rows = new Map();
  const totals = { in: 0, out: 0, cache_write: 0, cache_read: 0 };
  for (const r of records) {
    const key = `${r.source}\u0000${r.model ?? 'unknown'}`;
    const row = rows.get(key) ?? {
      source: r.source, model: r.model ?? 'unknown',
      turns: 0, in: 0, out: 0, cache_write: 0, cache_read: 0,
    };
    row.turns++;
    for (const k of ['in', 'out', 'cache_write', 'cache_read']) {
      row[k] += r[k]; totals[k] += r[k];
    }
    rows.set(key, row);
  }
  return { rows: [...rows.values()].sort((a, b) => b.in + b.cache_read - (a.in + a.cache_read)), totals };
}

// What a tool costs is not the turn that called it -- that turn's input is the
// whole conversation so far. It is the tokens its RESULT adds to the context,
// which every later turn then pays for again.
//
//     footprint = context(next) - context(this) - output(this)
// A subagent runs in its own, much smaller context but is written to the same
// transcript under the same session id. Interleaving the two makes the context
// look like it shrank, so they are measured as separate threads.
const threadOf = (r) => `${r.session}${r.extra?.sidechain ? '\u0000sidechain' : ''}`;

export function attribute(records) {
  const sessions = new Map();
  for (const r of records) {
    const key = threadOf(r);
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(r);
  }
  const byTool = new Map();
  const excluded = { compacted: 0, multiTool: 0, lastTurn: 0 };

  for (const turns of sessions.values()) {
    turns.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (!turn.tools.length) continue;
      const next = turns[i + 1];
      if (!next) { excluded.lastTurn++; continue; }
      // Several tools in one turn share a single footprint and cannot be split
      // without knowing each result's size. 0.2% of turns, so they are counted
      // and left out rather than apportioned by guesswork.
      if (turn.tools.length > 1) { excluded.multiTool++; continue; }
      const growth = contextOf(next) - contextOf(turn);
      // A shrinking context means the two turns are not consecutive in one
      // thread: a compaction, or a transcript that holds several branches of a
      // rewound conversation. Either way the arithmetic is meaningless here.
      // Excluded, never clamped to zero -- zero would read as a free call.
      if (growth < 0) { excluded.compacted++; continue; }
      const entry = Math.max(0, growth - turn.out);
      const name = turn.tools[0];
      const acc = byTool.get(name) ?? { tool: name, domain: domainOf(name), calls: 0, entry: 0, carried: 0 };
      acc.calls++;
      acc.entry += entry;
      acc.carried += entry * (turns.length - 1 - i);
      byTool.set(name, acc);
    }
  }
  return { byTool: [...byTool.values()].sort((a, b) => b.entry - a.entry), excluded };
}

export function byDomain(tools) {
  const rows = new Map();
  for (const t of tools) {
    const key = t.domain ?? 'not ps-mcp';
    const row = rows.get(key) ?? { domain: key, calls: 0, entry: 0, carried: 0 };
    row.calls += t.calls; row.entry += t.entry; row.carried += t.carried;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.entry - a.entry);
}
