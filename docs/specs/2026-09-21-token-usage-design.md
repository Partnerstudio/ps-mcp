# Token usage ledger

Status: design, not yet implemented. 2026-09-21.

## Goal

Record every token an employee spends on AI, of every kind -- input, output,
cache write, cache read -- attributed to a model and a source, on their own
machine, so that a pilot can be costed afterwards.

The minimum bar is the tokens themselves. Money is a calculation over them and
is deliberately not part of this round.

## Scope

In:

- Claude Code sessions (the CLI, and Claude Code running inside Claude Desktop).
- Codex sessions.
- A durable local ledger that survives the clients deleting their transcripts.
- A `ps-mcp usage` report.

Out, this round, each for a stated reason:

- **Prices and money.** Recording model plus every token class means cost can be
  computed later, retroactively, over data already collected. A price table
  built now would be guesswork we would have to revisit anyway.
- **Central collection.** The record format is designed so an upload step is an
  addition rather than a rewrite, but nothing leaves the machine yet.
- **ps-mcp's own tool calls.** They consume no tokens. Their cost shows up as
  the bytes they return into the model's context, which is a different
  measurement and a separate piece of work.
- **Claude Desktop chat.** It keeps no local token record. See below.

## What makes this possible

The clients already write token accounting to disk. Nothing needs to be
intercepted, and the MCP server is not involved at all.

| Source | File | Tokens | Model |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | `message.usage` | `message.model` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `token_count` events | `turn_context.model` |
| Claude Desktop chat | -- | none on disk | -- |

Claude Code carries the full breakdown, including the cache TTL split that
matters for pricing later:

    input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens,
    cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens},
    output_tokens_details.thinking_tokens

Codex carries `input_tokens, cached_input_tokens, cache_write_input_tokens,
output_tokens, reasoning_output_tokens`.

Neither returns a cost. No model API does -- token counts come per call, money
comes from org-level usage endpoints. That asymmetry is why this design records
tokens and prices them separately.

**Claude Desktop chat is a real gap.** Ordinary Desktop conversations leave no
local token record; `claude-code-sessions/` holds session metadata and a model
id but no usage. A pilot report must say so rather than let a reader assume the
total is complete.

## Architecture

Three parts, all in the CLI. The MCP server is untouched.

    src/usage.js        adapters + normalise + aggregate   (pure, testable)
    src/cli.js          `ps-mcp usage` subcommand
    ~/.config/ps-mcp/usage/tokens.jsonl    the ledger

Because collection runs in the CLI, it runs **outside** the Seatbelt sandbox.
The server never reads a transcript and never writes the ledger, so the sandbox
profile is unchanged. This is the main reason to put collection here rather
than in the server.

### Record

One record per billable unit, one JSON object per line:

```json
{"ts":"2026-09-19T07:54:30.100Z","source":"claude-code",
 "id":"msg_011CfCSLxLA2RQVjkiaUYDdA","session":"23e6f3c3","model":"claude-opus-5",
 "in":2,"out":1346,"cache_write":34955,"cache_read":24866,
 "extra":{"cache_write_1h":34955,"cache_write_5m":0,"thinking":942,"sidechain":false}}
```

`ts, source, id, session, model, in, out, cache_write, cache_read` are common to
every source. `extra` holds whatever that source reports and nothing else does.
A future service that bills in characters rather than tokens keeps the envelope
and replaces the four token fields -- that is what makes this extensible without
a redesign.

`id` is the deduplication key, scoped by source:

- Claude Code: `message.id`, the API's own response id.
- Codex: `<session_id>:<ordinal>`.

### Flow

    scan transcripts -> normalise -> drop ids already in the ledger -> append
                                                                   -> report

Re-running is safe and idempotent. The ledger is the durable copy; transcripts
are the source of truth only for as long as the clients keep them.

## Correctness risks

These are the ways this silently produces a wrong number. Each needs a test.

1. **Codex cumulative vs delta.** Every `token_count` event carries both
   `total_token_usage` (cumulative for the session) and `last_token_usage`
   (that turn). Summing the wrong one inflates a session quadratically. The
   design sums `last_token_usage`, and validates the result against the final
   `total_token_usage` for that session, warning on mismatch rather than
   silently reporting either.

2. **Claude Code `iterations`.** `message.usage` contains an `iterations` array
   whose entries repeat the same counts. In a 1,070-message sample no message
   had more than one iteration, so the top-level figure is authoritative and
   iterations are ignored. Where a message does have several, take the
   top-level figure and warn, rather than assume the relationship.

3. **Subagent turns are real spend.** Claude Code marks them `isSidechain`.
   They cost money and must be counted, but recorded as `extra.sidechain` so a
   report can separate "what the person asked for" from "what it fanned out to".

4. **Model attribution in Codex.** The model lives in `turn_context`, not in the
   usage event, and a session can switch models. Each `token_count` is
   attributed to the most recent preceding `turn_context`. Events before any
   `turn_context` are recorded with `model: null` rather than guessed.

5. **Transcript retention.** Clients clean up. The ledger exists precisely so a
   pilot report written in week six can still see week one.

6. **Concurrent appends.** Two `ps-mcp usage` runs at once could interleave.
   Deduplication is what makes this safe: a doubled or interleaved write is
   discarded on the next read. `O_APPEND` with one write per line keeps it
   unlikely in the first place, but the correctness rests on the dedup, not on
   an atomicity guarantee.

## Privacy

Recorded: token counts, model ids, timestamps, opaque session and message ids,
and a boolean for sidechain.

Never recorded: prompts, completions, file paths, working directories, tool
arguments, or any message content. The adapters read the specific fields named
in this document and copy nothing else.

This is an invariant, not an intention, so it gets a test: run the adapters over
a fixture containing a distinctive secret string in every content field and
assert the string appears in no output record.

The transcripts themselves stay where they are. Nothing is copied, moved or
uploaded.

## Errors

Nothing here should ever fail a user's day. Collection is best-effort and loud
about what it skipped:

- Missing `~/.claude` or `~/.codex`: not an error. That source reports zero.
- Unparseable line: skipped, counted, total reported at the end.
- A record whose shape is not recognised: skipped and counted separately from
  parse failures, because a steady count there means a client changed format.
- Unreadable file: skipped with its name.

`ps-mcp usage` exits non-zero only if it cannot write the ledger.

## Report

    ps-mcp usage [--since YYYY-MM-DD] [--json]

Default output groups by source and model, with a column per token class and a
total row. It states the collection window, the number of skipped records, and
plainly that Claude Desktop chat is not included.

`--json` emits the aggregate for sending on. This is the seam a later central
collection step plugs into.

## Testing

`test/usage.test.js`, node:test, fixtures checked in:

- Claude Code fixture: normal message, sidechain message, a message with several
  iterations, a malformed line.
- Codex fixture: a session with several `token_count` events and a mid-session
  model switch; asserts the delta sum matches the final cumulative figure.
- Deduplication: collecting the same fixture twice yields one set of records.
- Privacy: no content string from either fixture appears in any output record.
- Missing directories produce an empty result, not an exception.

## Success criteria

1. `ps-mcp usage` on a machine that has used Claude Code and Codex reports
   non-zero totals for both, broken down by model and token class.
2. Running it twice does not change the totals.
3. Deleting a source transcript afterwards does not change the totals.
4. Codex per-session delta sums equal that session's final cumulative figure.
5. No fixture content string appears anywhere in the ledger.
6. The report names what it cannot see.

## Deferred, with defaults

- **Other AI services (ElevenLabs, OpenAI).** Needs the other collection
  mechanism -- metered at the point ps-mcp makes the call, where the vendor's
  own accounting is in the response. The record envelope above already
  accommodates non-token units. Separate spec.
- **Money.** A price table keyed by model, applied at report time, with each
  figure stamped with the table version so a price change cannot silently
  rewrite history. Until then the report shows tokens only.
- **Subscription versus API billing.** If the employee is on a subscription
  seat, any future money figure is notional -- what the usage would have cost at
  API rates -- and must be labelled as such, or it will end up in a budget.
