import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  aggregate, attribute, byDomain, collect, domainOf,
  newRecords, parseClaudeCode, parseCodex,
} from '../src/usage.js';

const SECRET = 'SECRET-PROMPT-CONTENT-DO-NOT-COPY';

const claudeTurn = (id, seqTs, usage, extra = {}) => JSON.stringify({
  timestamp: seqTs,
  sessionId: 'sess-1',
  ...extra,
  message: {
    id, model: 'claude-opus-5', role: 'assistant',
    content: [{ type: 'text', text: SECRET }, ...(extra.tools ?? [])],
    usage,
  },
});

const usage = (over = {}) => ({
  input_tokens: 2, output_tokens: 100,
  cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
  output_tokens_details: { thinking_tokens: 40 },
  ...over,
});

describe('parseClaudeCode', () => {
  const text = [
    claudeTurn('msg_1', '2026-09-20T10:00:00.000Z', usage(), {
      tools: [{ type: 'tool_use', name: 'gmail_read', input: { query: SECRET } }],
    }),
    claudeTurn('msg_2', '2026-09-20T10:01:00.000Z', usage(), { isSidechain: true }),
    claudeTurn('msg_3', '2026-09-20T10:02:00.000Z', usage({ iterations: [{}, {}] })),
    '{ not json at all',
    JSON.stringify({ message: { model: 'x', usage: usage() } }),   // no id
    '',
  ].join('\n');

  const { records, skipped } = parseClaudeCode(text, { file: '/x/sess-1.jsonl' });

  it('reads every token class', () => {
    assert.equal(records[0].in, 2);
    assert.equal(records[0].out, 100);
    assert.equal(records[0].cache_write, 1000);
    assert.equal(records[0].cache_read, 5000);
    assert.equal(records[0].extra.cache_write_1h, 1000);
    assert.equal(records[0].extra.thinking, 40);
  });

  it('keeps the tool name that caused the turn', () => {
    assert.deepEqual(records[0].tools, ['gmail_read']);
  });

  it('marks subagent turns instead of dropping them', () => {
    assert.equal(records[1].extra.sidechain, true, 'sidechain spend is real spend');
    assert.equal(records[0].extra.sidechain, false);
  });

  it('counts a multi-iteration message but still uses the top-level figure', () => {
    assert.equal(skipped.iterations, 1);
    assert.equal(records[2].in, 2, 'top level is authoritative');
  });

  it('counts a malformed line and a record with no id, and keeps going', () => {
    assert.equal(skipped.parse, 1);
    assert.equal(skipped.shape, 1);
    assert.equal(records.length, 3);
  });

  // The invariant, not an intention: only counts and opaque ids leave here.
  it('copies no message content', () => {
    assert.equal(JSON.stringify(records).includes(SECRET), false);
  });
});

describe('parseCodex', () => {
  const ev = (ordinal, last, total, model) => JSON.stringify({
    timestamp: '2026-09-20T11:00:00.000Z', ordinal, type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } },
  });
  const turnCtx = (ordinal, model) => JSON.stringify({
    timestamp: '2026-09-20T11:00:00.000Z', ordinal, type: 'turn_context', payload: { model },
  });
  const call = (ordinal, name) => JSON.stringify({
    timestamp: '2026-09-20T11:00:00.000Z', ordinal, type: 'response_item',
    payload: { type: 'custom_tool_call', name, input: SECRET },
  });
  const meta = JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { session_id: 'cx-1' } });

  // Codex reports input_tokens as the TOTAL, with cached and cache-write as
  // subsets. 300 total = 100 cached + 150 written + 50 genuinely fresh.
  const t1 = { input_tokens: 300, cached_input_tokens: 100, cache_write_input_tokens: 150, output_tokens: 20 };
  const t2 = { input_tokens: 500, cached_input_tokens: 400, cache_write_input_tokens: 50, output_tokens: 30 };

  const text = [
    meta, turnCtx(1, 'gpt-5.6-sol'), call(2, 'exec'),
    ev(3, t1, { input_tokens: 300, output_tokens: 20 }),
    turnCtx(4, 'gpt-5.6-mini'),
    ev(5, t2, { input_tokens: 800, output_tokens: 50 }),
  ].join('\n');

  const { records, skipped } = parseCodex(text);

  it('normalises input so it is disjoint from the cache fields', () => {
    assert.equal(records[0].in, 50, '300 total - 100 cached - 150 written');
    assert.equal(records[0].cache_read, 100);
    assert.equal(records[0].cache_write, 150);
  });

  it('attributes each turn to the model in force at the time', () => {
    assert.equal(records[0].model, 'gpt-5.6-sol');
    assert.equal(records[1].model, 'gpt-5.6-mini', 'a mid-session switch must follow');
  });

  it('attaches the tool call that preceded the token event', () => {
    assert.deepEqual(records[0].tools, ['exec']);
    assert.deepEqual(records[1].tools, [], 'and does not leak it into the next turn');
  });

  it('sums deltas, not the cumulative counter', () => {
    assert.equal(records[0].in + records[0].cache_read + records[0].cache_write, 300);
    assert.equal(skipped.mismatch, 0, 'deltas agree with the final cumulative figure');
  });

  it('flags a session whose deltas do not add up to its own total', () => {
    const bad = [meta, turnCtx(1, 'm'), ev(2, t1, { input_tokens: 99999, output_tokens: 1 })].join('\n');
    assert.equal(parseCodex(bad).skipped.mismatch, 1);
  });

  it('copies no tool input', () => {
    assert.equal(JSON.stringify(records).includes(SECRET), false);
  });
});

describe('attribute', () => {
  // ctx = in + cache_write + cache_read. Four turns, growing 100 -> 1000.
  const turn = (seq, ctx, out, tools) => ({
    source: 'claude-code', session: 's', seq, id: `m${seq}`, model: 'claude-opus-5',
    in: ctx, out, cache_write: 0, cache_read: 0, tools, extra: {},
  });

  it('measures the footprint a tool result adds to context', () => {
    const { byTool, excluded } = attribute([
      turn(0, 100, 10, ['gmail_read']),
      turn(1, 600, 10, []),
      turn(2, 700, 10, []),
      turn(3, 800, 10, []),
    ]);
    const row = byTool.find((t) => t.tool === 'gmail_read');
    assert.equal(row.entry, 490, 'ctx(next) - ctx(this) - output = 600 - 100 - 10');
    assert.equal(row.carried, 490 * 3, 'and every later turn pays for it again');
    assert.equal(row.calls, 1);
    assert.equal(row.domain, 'Mail');
    assert.deepEqual(excluded, { compacted: 0, multiTool: 0, lastTurn: 0 });
  });

  it('excludes and counts a compacted turn rather than calling it free', () => {
    const { byTool, excluded } = attribute([
      turn(0, 9000, 10, ['sheets_read']),
      turn(1, 400, 10, []),        // compaction: context shrank
    ]);
    assert.equal(excluded.compacted, 1);
    assert.equal(byTool.length, 0, 'no zero-cost row that would read as free');
  });

  it('excludes and counts a turn that called several tools', () => {
    const { byTool, excluded } = attribute([
      turn(0, 100, 10, ['gmail_read', 'calendar_read']),
      turn(1, 900, 10, []),
    ]);
    assert.equal(excluded.multiTool, 1);
    assert.equal(byTool.length, 0);
  });

  it('excludes and counts the last turn, which has no successor to measure', () => {
    const { excluded } = attribute([turn(0, 100, 10, ['drive_read'])]);
    assert.equal(excluded.lastTurn, 1);
  });

  it('keeps sessions apart', () => {
    const other = { ...turn(0, 50, 5, ['docs_read']), session: 'other' };
    const { byTool } = attribute([turn(0, 100, 10, ['gmail_read']), turn(1, 600, 10, []), other]);
    assert.equal(byTool.find((t) => t.tool === 'docs_read'), undefined, 'no successor in its own session');
  });
});

describe('domainOf and byDomain', () => {
  it('maps each service prefix to its domain', () => {
    assert.equal(domainOf('gmail_send'), 'Mail');
    assert.equal(domainOf('calendar_agenda'), 'Calendar');
    assert.equal(domainOf('sheets_append_row'), 'Sheets');
    assert.equal(domainOf('slides_read'), 'Slides');
    assert.equal(domainOf('s3_put'), 'Storage');
    assert.equal(domainOf('ffprobe_info'), 'Media');
    assert.equal(domainOf('gws_schema'), 'Discovery');
  });

  it('leaves a tool that is not ours unclassified', () => {
    assert.equal(domainOf('Bash'), null);
  });

  // A workflow touches calendar, docs and mail at once. Filing it under one
  // would make three domain totals wrong invisibly.
  it('gives each workflow its own line and no domain', () => {
    assert.equal(domainOf('workflow_meeting_prep'), 'workflow_meeting_prep');
    const rows = byDomain([
      { tool: 'gmail_read', domain: 'Mail', calls: 2, entry: 100, carried: 200 },
      { tool: 'gmail_send', domain: 'Mail', calls: 1, entry: 50, carried: 50 },
      { tool: 'workflow_meeting_prep', domain: 'workflow_meeting_prep', calls: 1, entry: 900, carried: 900 },
      { tool: 'Bash', domain: null, calls: 5, entry: 10, carried: 10 },
    ]);
    const mail = rows.find((r) => r.domain === 'Mail');
    assert.equal(mail.entry, 150, 'the two mail tools, and nothing else');
    assert.equal(mail.calls, 3);
    assert.ok(rows.find((r) => r.domain === 'workflow_meeting_prep'), 'its own line');
    assert.ok(rows.find((r) => r.domain === 'not ps-mcp'), 'other tools stay visible but separate');
  });
});

describe('aggregate', () => {
  it('totals every token class per source and model', () => {
    const r = (source, model, over) => ({
      source, model, in: 1, out: 2, cache_write: 3, cache_read: 4, tools: [], ...over,
    });
    const { rows, totals } = aggregate([r('claude-code', 'claude-opus-5'), r('claude-code', 'claude-opus-5'), r('codex', 'gpt-5.6-sol')]);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((x) => x.source === 'claude-code').turns, 2);
    assert.deepEqual(totals, { in: 3, out: 6, cache_write: 9, cache_read: 12 });
  });
});

describe('newRecords', () => {
  const rec = (source, id) => ({ source, id });
  it('returns only what the ledger does not already hold', () => {
    const existing = [rec('claude-code', 'msg_1')];
    const added = newRecords(existing, [rec('claude-code', 'msg_1'), rec('claude-code', 'msg_2')]);
    assert.deepEqual(added, [rec('claude-code', 'msg_2')]);
  });

  it('collapses duplicates inside one batch', () => {
    assert.equal(newRecords([], [rec('codex', 'a'), rec('codex', 'a')]).length, 1);
  });

  it('keeps the same id from two sources apart', () => {
    assert.equal(newRecords([rec('codex', 'x')], [rec('claude-code', 'x')]).length, 1);
  });
});

describe('collect', () => {
  it('returns nothing, and does not throw, when neither client is installed', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'ps-mcp-usage-'));
    const got = collect({ claudeDir: path.join(base, 'nope'), codexDir: path.join(base, 'also-nope') });
    assert.deepEqual(got.records, []);
    assert.deepEqual(got.skipped.unreadable, []);
  });

  it('walks nested session directories', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'ps-mcp-usage-'));
    const deep = path.join(base, 'codex', '2026', '09', '20');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, 'rollout-x.jsonl'), [
      JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { session_id: 'cx-9' } }),
      JSON.stringify({
        ordinal: 1, type: 'event_msg', timestamp: '2026-09-20T00:00:00.000Z',
        payload: { type: 'token_count', info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 },
          total_token_usage: { input_tokens: 10, output_tokens: 5 },
        } },
      }),
    ].join('\n'));
    const got = collect({ claudeDir: path.join(base, 'none'), codexDir: path.join(base, 'codex') });
    assert.equal(got.records.length, 1);
    assert.equal(got.records[0].session, 'cx-9');
  });
});
