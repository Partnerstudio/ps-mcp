# ps-mcp

Local MCP server exposing CLI tools to Claude Desktop, Claude Code and the
ChatGPT/Codex host on Partnerstudio Macs. Stdio only, no remote server.

Design decisions live in `CLAUDE.md`. This file covers running it.

## Layout

    etc/tools.yaml              tool manifest (what tools exist, and their argv)
    etc/ps-mcp.sb               Seatbelt profile (kernel-level disk isolation)
    etc/iam-policy.example.json minimum IAM policy for the S3 tools
    launcher/                   ps-mcp-launch -- point MCP clients at this
    src/                        server, manifest loader, exec + sdk runners,
                                path guard, S3 tools
    test/                       node:test, no framework

## Running

    npm ci
    npm run setup               # resolve binaries -> etc/binaries.conf
    npm test
    launcher/ps-mcp-launch      # speaks JSON-RPC on stdin/stdout

`npm run setup` (bin/ps-mcp-resolve) is the one place a PATH lookup happens. It
runs `command -v` in your shell, follows symlinks, and records absolute paths
plus their install prefixes in `etc/binaries.conf`. Everything downstream uses
those absolute paths, and the Seatbelt profile grants exactly those prefixes --
so nothing has to guess between Homebrew on Apple Silicon (`/opt/homebrew`),
Homebrew on Intel (`/usr/local`) and a version-specific nvm directory.

Re-run it after installing or upgrading a tool. `etc/binaries.conf` is
gitignored because it is machine-specific. Without it the launcher stops with a
message naming the script; individual tools whose binary is missing are skipped
with a warning and the rest still serve.

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`, using
an absolute path (Claude Desktop spawns servers with a near-empty environment):

```json
{
  "mcpServers": {
    "ps-mcp": {
      "command": "/ABSOLUTE/PATH/TO/ffwd/launcher/ps-mcp-launch"
    }
  }
}
```

Restart Claude Desktop, then ask it to probe a file in `~/Downloads`.

If tools do not appear, the server's stderr goes to
`~/Library/Logs/Claude/mcp-server-ps-mcp.log`. macOS may also need Claude
Desktop granted Files and Folders access for `~/Downloads`, since the sandboxed
child inherits Claude Desktop's TCC context.

## The ps-mcp command

    ps-mcp setup      wire up Claude Desktop and Codex, resolving binaries first
    ps-mcp auth       sign in to Google in a browser
    ps-mcp doctor     check binaries, manifest, auth, client configs
    ps-mcp channel    show or set the release channel
    ps-mcp serve      run the server in the foreground

`setup` backs up any config it touches and edits only the `ps-mcp` entry, so
other MCP servers are left exactly as they were.

### Release channels

Each channel is the head of the branch of the same name, and a build is promoted
by merging forward:

    dev  ->  prod  ->  stable

- **dev** - every merge to the dev branch; expect breakage
- **prod** - promoted from dev and soaking; broadly trustworthy
- **stable** - promoted from prod after soaking; the most conservative

Note the ordering: `stable` is the most conservative, not `prod`. A machine's
channel lives in `etc/channel` (gitignored, machine-local) and defaults to
`stable`.

### Credentials

Two different things get called credentials, and they are provisioned
differently:

- **User tools** (gws) authenticate as the person, through the CLI's own browser
  flow. `ps-mcp auth` starts it. The resulting token is theirs, encrypted in
  their home directory, never shared. gws does need an OAuth *client* to exist
  before that flow can start -- that is the application's identity, not a user
  credential, and it ships with the install.
- **Service access** (AWS) uses IAM credentials placed in `~/.aws/credentials`
  as a normal profile. Cloud API access is out of scope for now.

## Shell contexts

macOS defaults to zsh, but three different shells are in play here. Mixing them
up is the single easiest way to break something:

| Where | Shell | Consequence |
|---|---|---|
| Your terminal / an agent's Bash tool | `/bin/zsh` | unquoted `$VAR` does **not** word-split; `USERNAME`, `PATH`, `status` and friends are reserved and silently unassignable |
| `launcher/ps-mcp-launch` | `#!/bin/sh` = bash 3.2 POSIX mode | keep it POSIX: no arrays, no `[[ ]]`, no `local` |
| Tools run by the server | none | `execFile` with an argv array |

The server never spawns a shell. That is why `{{param}}` interpolation is safe:
a value with spaces, quotes or a `;` stays exactly one argv element. Adding
`shell: true` or an `exec()` with a command string would turn every tool
parameter into an injection vector.

When running commands by hand against AWS or anything outside the repo, quote
every expansion and assert a variable took before the call that mutates:

    IAM_USER=ps-mcp-test
    [ "$IAM_USER" = "ps-mcp-test" ] || { echo "ABORT"; exit 1; }

## The work root

Tools may only touch paths under the work root: `$PS_MCP_WORK`, defaulting to
`$HOME`. Two carve-outs apply, enforced both by `src/paths.js` (so the model
gets a readable error) and by `etc/ps-mcp.sb` (so a bug in that guard is not
enough to read anything):

- anything hidden: `~/.ssh`, `~/.aws`, `~/.gnupg`, a stray `.env` in a project
- `~/Library`, which has no leading dot but holds Keychains, Mail and Messages

`~/.aws` is re-granted read-only and `~/.config/gws` read-write, because the S3
and gws tools read credentials from their own stores.

To narrow the root:

    PS_MCP_WORK=~/Downloads launcher/ps-mcp-launch

## S3 tools

`s3_list`, `s3_get`, `s3_put` (multipart), `s3_presign`, `s3_delete`. Credentials
come from the SDK default chain reading `~/.aws`; nothing is injected and the
server never reads a secret itself. The launcher pins `AWS_PROFILE=default`,
overridable:

    PS_MCP_AWS_PROFILE=partnerstudio launcher/ps-mcp-launch

**There is no bucket allowlist. The IAM policy on that user is the security
boundary.** Scope it before pointing this at anything that matters --
`etc/iam-policy.example.json` is the minimum these five tools need. Three things
that policy has to get right:

- `s3:ListBucket` is a *bucket* permission; the object actions are *object*
  permissions on `bucket/prefix/*`. Both are needed.
- If the bucket has SSE-KMS default encryption, uploads also need
  `kms:GenerateDataKey` and `kms:Decrypt`, or `s3_put` fails with `AccessDenied`
  on `kms:GenerateDataKey` even though every S3 permission is present.
- `s3_presign` resolves the bucket's region with `HeadBucket`, which needs
  `s3:ListBucket` *without* a prefix condition. Under a prefix-scoped policy that
  lookup is denied and it falls back to the configured region, which is correct
  only for same-region buckets.

A presigned URL is a bearer credential: anyone holding it downloads the object
with no further auth until it expires. Expiry is capped at `presignMaxSeconds`
in `etc/tools.yaml` (24h) regardless of what is requested, and the response
reports the value actually used. The URL is signed for `GET` specifically --
a `HEAD` against it fails the signature check with 403, which is not a bug.

## Google Workspace tools

Backed by the `gws` CLI, which is uniform: `gws <service> <resource> [sub] <method>
--params JSON [--json BODY]`. That shape means full API coverage costs few tools.

**Helpers** wrap the common operations with named flags, and are what to reach for
first: `gmail_send`, `gmail_triage`, `calendar_agenda`, `calendar_create_event`,
`drive_upload`, `sheets_get_range`, `sheets_append_row`, `docs_append_text`,
`chat_send_message`, plus the cross-service `workflow_*` tools.

**Generic tools** reach everything else, one read and one write per service:
`gmail_*`, `calendar_*`, `drive_*`, `sheets_*`, `docs_*`, `slides_*`. The split
exists so the hints stay honest -- a read tool constrains `method` to an enum of
read verbs and is `readOnly`, a write tool is not, and is `destructive` only
where the service can actually delete.

Eight further services exist in gws -- Chat, Meet, Forms, Keep, People, Apps
Script, Admin Reports and Tasks -- but are **not generated**, because the
credentials cannot reach them: most lack a granted OAuth scope, and Tasks, Keep
and Apps Script also have their API disabled in the Cloud project. A tool that
always fails is worse than an absent one, since the model cannot tell "not
permitted" from "wrong arguments" and burns turns retrying. `BLOCKED` in
`tools/gen-gws-tools.mjs` lists one reason each; delete an entry and regenerate
once the scope or API lands.

**`gws_schema`** returns the parameters and request body for any method, addressed
as `service.resource.method` (e.g. `drive.files.list`). Use it rather than guessing.

Two things worth knowing:

- ps-mcp gives gws its **own** config directory, `~/.config/ps-mcp/gws`, rather
  than sharing gws's default (`~/Library/Application Support/gws`). gws deletes
  credentials it cannot decrypt, so a single call from your shell, a gws skill or
  another MCP server under the default keyring backend wipes the server's login.
  Isolation removes that entirely; `ps-mcp auth` signs in there and nothing else
  touches it. Override with `PS_MCP_GWS_DIR`. gws's own JSON logs are written to
  `logs/` inside it.
- The launcher grants that directory to `node --permission` too, because a
  node-based child **inherits** the parent's permission flags.
- `gws` is a `#!/usr/bin/env node` script, so the child environment must carry a
  PATH containing node. `exec-tool.js` derives it from `process.execPath`; without
  it every gws tool fails with a bare `env: node: No such file or directory`.

Groups (the Admin SDK Directory API) is **not** in gws 0.8.0, so there are no
Groups tools. The available services are the ones listed by `gws --help`.

## Adding a tool

Add an entry to `etc/tools.yaml`. Structural mistakes fail at startup with a
message naming the tool and field; a missing binary only skips that one tool.

```yaml
  - name: my_tool
    type: exec
    binary: ffmpeg            # must be a key under top-level `binaries`
    title: Short label
    description: What it does, written for the model to read.
    timeoutMs: 30000
    hints: { readOnly: false, destructive: false }   # both required
    output: text              # or json
    params:
      - name: input
        type: string          # string | integer | number | boolean | enum
        required: true
        path: true            # canonicalise; must resolve under the work root
        description: Input file.
    argv: ["-i", "{{input}}"]
```

`argv` rules:

- each entry is exactly one `execFile` argument -- there is no shell
- `{{param}}` interpolates *inside* a token, so `"scale={{w}}:{{h}}"` is one
  argument and cannot be split or injected into
- a token referencing a param that was not supplied is dropped whole, which is
  how optional flags work without conditionals

Two entry types exist. `exec` tools declare a `binary` and an `argv` template.
`sdk` tools are implemented in code, keyed by tool name (see `src/s3-tools.js`),
and take no `binary`, `argv` or `output` -- declaring any of those is rejected at
startup. Both kinds share argument binding, so `path: true` behaves identically.

## Not built yet

gws tools, background jobs for long ffmpeg runs, progress notifications,
`ps-mcp setup` / `ps-mcp doctor`, and the Homebrew formula.
