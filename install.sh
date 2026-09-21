#!/bin/sh
# ps-mcp installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Partnerstudio/ps-mcp/dev/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --channel dev
#
# Assumes nothing but macOS. A fresh Mac has no node, no gws and no Homebrew, so
# this fetches its own -- pinned and checksum-verified -- into one directory that
# you can delete to uninstall. No admin, no Xcode Command Line Tools, nothing
# installed system-wide and nothing else on the machine changed.
set -eu

CHANNEL=stable
PREFIX="$HOME/.local/ps-mcp"
NODE_VERSION=v24.21.0
REPO=Partnerstudio/ps-mcp

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL=$2; shift 2 ;;
    --prefix)  PREFIX=$2; shift 2 ;;
    -h|--help)
      echo "usage: install.sh [--channel dev|beta|stable] [--prefix DIR]"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in Darwin) ;; *) echo "ps-mcp is macOS only." >&2; exit 1 ;; esac
case "$(uname -m)" in
  arm64) NODE_ARCH=darwin-arm64 ;;
  x86_64) NODE_ARCH=darwin-x64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

say() { printf '  %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# Verify before use, every time. A download that fails its checksum is refused,
# never "probably fine".
verify() {
  got=$(shasum -a 256 "$1" | cut -d' ' -f1)
  [ "$got" = "$2" ] || die "checksum mismatch for $(basename "$1"): expected $2, got $got"
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

printf '\nps-mcp installer\n\n'
say "channel:      $CHANNEL"
say "install into: $PREFIX"
say "architecture: $NODE_ARCH"
printf '\n'

# --- ps-mcp ------------------------------------------------------------------
# version.json shares a URL across builds so it can be served stale; the assets
# it names carry the build in their filename and cannot be.
say "fetching the $CHANNEL release index..."
BASE="https://github.com/$REPO/releases/download/release-$CHANNEL"
curl -fsSL -H 'Cache-Control: no-cache' -o "$WORK/version.json" \
  "$BASE/version.json?t=$(date +%s)" \
  || die "no release found for channel '$CHANNEL'"

read_json() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\).*/\1/p" "$WORK/version.json" | head -1; }
ASSET=$(read_json asset)
SHA=$(read_json sha256)
BUILD=$(read_json version)
[ -n "$ASSET" ] && [ -n "$SHA" ] || die "could not read the release index"
say "version:      $BUILD"

say "downloading ps-mcp..."
curl -fsSL -o "$WORK/$ASSET" "$BASE/$ASSET"
verify "$WORK/$ASSET" "$SHA"
say "  checksum ok"

# --- node --------------------------------------------------------------------
# Its own node, not whatever is on PATH: a fresh Mac has none, and pinning means
# an install cannot be broken later by someone changing their node.
say "downloading node $NODE_VERSION..."
NODE_TGZ="node-$NODE_VERSION-$NODE_ARCH.tar.gz"
curl -fsSL -o "$WORK/$NODE_TGZ" "https://nodejs.org/dist/$NODE_VERSION/$NODE_TGZ"
curl -fsSL -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
NODE_SHA=$(grep " $NODE_TGZ\$" "$WORK/SHASUMS256.txt" | cut -d' ' -f1)
[ -n "$NODE_SHA" ] || die "no published checksum for $NODE_TGZ"
verify "$WORK/$NODE_TGZ" "$NODE_SHA"
say "  checksum ok"

# --- unpack ------------------------------------------------------------------
STAGE="$WORK/stage"
mkdir -p "$STAGE/vendor"
tar -xzf "$WORK/$ASSET" -C "$STAGE"
tar -xzf "$WORK/$NODE_TGZ" -C "$STAGE/vendor"
mv "$STAGE/vendor/node-$NODE_VERSION-$NODE_ARCH" "$STAGE/vendor/node"
NODE_BIN="$STAGE/vendor/node/bin/node"
[ -x "$NODE_BIN" ] || die "node did not unpack as expected"

# gws is a standalone binary, but its installer is an npm package -- and we have
# npm, because it ships inside the node tarball.
say "installing the Google Workspace CLI..."
PATH="$STAGE/vendor/node/bin:$PATH" \
  "$STAGE/vendor/node/bin/npm" install --silent --no-fund --no-audit \
    --prefix "$STAGE/vendor/gws" @googleworkspace/cli >/dev/null 2>&1 \
  || say "  (gws install failed; Workspace tools will be skipped until you re-run)"

# node ships C++ headers and docs for building native modules. Nothing here
# compiles anything, and they are a third of the install.
rm -rf "$STAGE/vendor/node/include" "$STAGE/vendor/node/share/doc" 2>/dev/null || true

# --- install -----------------------------------------------------------------
if [ -d "$PREFIX" ]; then
  say "replacing the existing install at $PREFIX"
  rm -rf "$PREFIX.old"
  mv "$PREFIX" "$PREFIX.old"
fi
mkdir -p "$(dirname "$PREFIX")"
mv "$STAGE" "$PREFIX"

# Record absolute paths once, here, with the binaries we just placed. Nothing
# downstream searches PATH.
GWS_BIN="$PREFIX/vendor/gws/node_modules/.bin/gws"
set -- node="$PREFIX/vendor/node/bin/node"
[ -x "$GWS_BIN" ] && set -- "$@" gws="$GWS_BIN"
for extra in ffprobe ffmpeg; do
  found=$(command -v "$extra" 2>/dev/null || true)
  [ -n "$found" ] && set -- "$@" "$extra=$found"
done
"$PREFIX/bin/ps-mcp-resolve" "$@" >/dev/null 2>&1 || true
printf '%s\n' "$CHANNEL" > "$PREFIX/etc/channel"

# A CLI on PATH is a convenience; the MCP clients are wired with absolute paths
# and do not depend on it.
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$PREFIX/bin/ps-mcp" "$HOME/.local/bin/ps-mcp"
  say "linked $HOME/.local/bin/ps-mcp"
fi

printf '\ninstalled %s (%s)\n\n' "$BUILD" "$CHANNEL"
printf 'Next:\n'
printf '  %s/bin/ps-mcp setup     wire up Claude Desktop and Codex\n' "$PREFIX"
printf '  %s/bin/ps-mcp auth      sign in to Google in a browser\n' "$PREFIX"
printf '  %s/bin/ps-mcp doctor    check everything\n' "$PREFIX"
printf '\nthen restart Claude Desktop.\n\n'
