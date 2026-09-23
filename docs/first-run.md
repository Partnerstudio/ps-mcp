# First run, for a tester

ps-mcp gives Claude Desktop (and Codex) a set of tools that act on your own
Google Workspace account -- mail, calendar, docs, sheets, slides, drive -- plus
S3 and media tools. It runs entirely on your machine. There is no server, and
nothing you do goes through anyone else's account.

This is a first real-world test, so the goal is as much to find out where the
instructions are wrong as to get it working. Please note anything that surprised
you, however small.

## What you need

- A Mac. Nothing has to be installed on it: no Homebrew, no node, no Xcode
  Command Line Tools. You do not need admin rights and you will not be asked
  for a password.
- Claude Desktop, installed from https://claude.ai/download and signed in.
- Your Schibsted Google account.
- `client_secret.json`, which Johan will send you separately. This is the
  *application's* identity -- it is not your login and it is not a password.
  You still sign in as yourself.

Everything below is typed into Terminal (Cmd-Space, type "Terminal").

## 1. Put the OAuth client in place

Save `client_secret.json` to your Downloads folder, then:

    mkdir -p ~/.config/ps-mcp/gws
    mv ~/Downloads/client_secret.json ~/.config/ps-mcp/gws/

If your browser saved it as `client_secret (1).json` or similar, rename it to
exactly `client_secret.json`. We have not yet decided how this file should be
distributed, which is part of what this test is for.

## 2. Install

Quit Claude Desktop first (Cmd-Q), then:

    curl -fsSL https://raw.githubusercontent.com/Partnerstudio/ps-mcp/stable/install.sh | sh

This does everything in one go:

- downloads its own node and its own copy of the Google Workspace CLI, checks
  both against published checksums, and puts everything in `~/.local/ps-mcp`.
  Nothing is installed system-wide.
- adds the `ps-mcp` command, and a line to `~/.zprofile` so new Terminal
  windows find it.
- wires up Claude Desktop and Codex, backing up any config it changes.
- opens a browser to sign in to Google. Choose your `@schibsted.no` account
  and accept the consent screen. The token is encrypted in your home directory
  and is yours alone.
- ends with `ps-mcp doctor`, a check of everything.

**Please tell us exactly what the consent screen said**, including any warning
about the app being unverified, and whether it let you through. This is the
step most likely to behave differently for you than it did for us.

If you skipped step 1, the installer finishes without signing in and tells
you what to do; after placing the file, run `~/.local/bin/ps-mcp auth`.

**Claude Code is separate, and per directory.** If you use it, enable ps-mcp
only where you want the tools (in a new Terminal window):

    ps-mcp project add ~/some/work/dir     # or no argument, for this directory
    ps-mcp project list

Registering it everywhere would add ~6,300 tokens to every Claude Code session
on your Mac, including ones that have nothing to do with mail or calendars.

## 3. Check

The installer's last step is `ps-mcp doctor`; you can re-run it any time. On a
Mac with no Homebrew and no AWS credentials, a good result looks like this --
three warnings, no failures:

    ps-mcp doctor

      ok    node     /Users/you/.local/ps-mcp/vendor/node/bin/node
      ok    gws      /Users/you/.local/ps-mcp/vendor/gws/node_modules/.bin/gws

      ok    manifest: 29 tools available
      warn  skipped ffprobe_info: `ffprobe` is not in etc/binaries.conf; ...

      ok    node     v24.21.0
      ok    gws      gws 0.22.5
      warn  could not ask brew about updates (not installed, or it failed)

      ok    channel: stable (promoted from beta after soaking; the most conservative)
      ok    Google: signed in (oauth2)
      warn  AWS: no ~/.aws/credentials - S3 tools will fail until credentials are added

      ok    Claude Desktop configured
      ok    Codex configured
      ok    Claude Code installed, no project directories enabled (`ps-mcp project add DIR`)
      ok    launcher is executable

    No failures, but 3 warning(s) above - some tools will not work.

Those three warnings are correct on a clean machine and are explained under
"Known gaps" below. Anything marked `FAIL` is a real problem.

## 4. Open Claude Desktop and try it

Open Claude Desktop (or, if it was running, quit it completely and reopen
it). Then ask for something ordinary:

- "What's on my calendar tomorrow?"
- "Find the last email from <someone> and summarise it."
- "Make a new Google Doc called Test and put a heading in it."

## What to send back

1. The full output of `ps-mcp doctor`.
2. What the consent screen said in step 2, and whether it let you through.
3. Anything that failed, with the exact message -- copied, not described.
4. Whether Claude Desktop actually lists the tools after restarting.
5. Any point where these instructions did not match what you saw.

## Known gaps (expected, not bugs)

- **No ffmpeg** unless you happen to have it. `ffprobe_info` is skipped and you
  get 29 tools instead of 30. If you have Homebrew and want the media tool,
  `brew install ffmpeg` then re-run `~/.local/ps-mcp/bin/ps-mcp-resolve`.
- **No AWS credentials**, so the five S3 tools will fail if called. Provisioning
  those is a separate step we have not done yet.
- **The brew warning** just means ps-mcp cannot check whether your tools are out
  of date. Harmless on a machine without Homebrew.

## Uninstall

First `ps-mcp project remove DIR` for any directory you enabled, then:

    rm -rf ~/.local/ps-mcp ~/.local/ps-mcp.old ~/.config/ps-mcp ~/.local/bin/ps-mcp

and remove the `ps-mcp` entry from
`~/Library/Application Support/Claude/claude_desktop_config.json` and the
`[mcp_servers.ps-mcp]` block from `~/.codex/config.toml`, and the line ending
`# added by ps-mcp` from `~/.zprofile`. Backups sit next to the originals.
