# ps-mcp

Local MCP server exposing CLI tools to Claude Desktop, Claude Code and the
ChatGPT/Codex host on Partnerstudio Macs. Stdio only, no remote server.

Design decisions live in `CLAUDE.md`. This file covers running it.

## Layout

    etc/tools.yaml      tool manifest (what tools exist, and their argv)
    etc/ps-mcp.sb       Seatbelt profile (kernel-level disk isolation)
    launcher/           ps-mcp-launch -- point MCP clients at this
    src/                server, manifest loader, exec runner, path guard
    test/               node:test, no framework

## Running

    npm ci
    npm test
    launcher/ps-mcp-launch      # speaks JSON-RPC on stdin/stdout

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

## Not built yet

`sdk` tools (S3), gws tools, background jobs for long ffmpeg runs, progress
notifications, `ps-mcp setup` / `ps-mcp doctor`, and the Homebrew formula.
