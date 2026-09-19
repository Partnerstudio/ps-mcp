// Containment guard for params marked `path: true` in etc/tools.yaml.
//
// The rule, in order: canonicalise the request (resolving symlinks), then it
// must sit under the work root, must not traverse a hidden component, and must
// not sit in an excluded subtree. Canonicalising first is what makes it safe --
// a symlink planted inside the root that points at ~/.ssh resolves to ~/.ssh
// and is then rejected by the hidden-component rule.
//
// Seatbelt (etc/ps-mcp.sb) enforces the same boundary at the kernel level. This
// guard exists to turn a denial into a clear tool error instead of an EPERM.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export class PathDenied extends Error {
  constructor(message, { requested, reason }) {
    super(message);
    this.name = 'PathDenied';
    this.requested = requested;
    this.reason = reason;
  }
}

export function workRoot() {
  return path.resolve(process.env.PS_MCP_WORK || homedir());
}

// ~/Library carries no leading dot, so the hidden-component rule below does not
// cover it -- and it holds Keychains, Mail, Messages and Application Support.
function excludedSubtrees(root) {
  return [path.join(root, 'Library')];
}

function expandTilde(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

// Codes that mean "cannot resolve this component", as opposed to a real fault.
// ERR_ACCESS_DENIED is node's own permission model refusing to stat a path the
// launcher never granted -- which is every path outside the work root, so it
// has to degrade into an ordinary containment rejection rather than a crash.
const UNRESOLVABLE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ERR_ACCESS_DENIED']);

// realpathSync fails on a path that does not exist yet, but output paths are
// legitimately missing. Canonicalise the deepest existing ancestor and re-attach
// the rest, so a symlinked parent is still resolved. Falling back to the lexical
// path is safe: anything we could not stat is outside the grant, and the
// containment check below rejects it.
function canonicalise(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.slice().reverse());
    } catch (err) {
      if (!UNRESOLVABLE.has(err.code)) throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveWorkPath(requested, { root = workRoot() } = {}) {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new PathDenied('path must be a non-empty string', {
      requested,
      reason: 'empty',
    });
  }

  const canonicalRoot = canonicalise(root);
  const resolved = canonicalise(path.resolve(canonicalRoot, expandTilde(requested)));

  if (!isInside(resolved, canonicalRoot)) {
    throw new PathDenied(
      `path resolves outside the work root (${canonicalRoot}): ${resolved}`,
      { requested, reason: 'outside-root' },
    );
  }

  const rel = path.relative(canonicalRoot, resolved);
  const hidden = rel.split(path.sep).find((part) => part.startsWith('.'));
  if (hidden) {
    throw new PathDenied(
      `path traverses a hidden entry (${hidden}), which is not readable: ${resolved}`,
      { requested, reason: 'hidden' },
    );
  }

  for (const subtree of excludedSubtrees(canonicalRoot)) {
    if (isInside(resolved, subtree)) {
      throw new PathDenied(`path is in an excluded subtree (${subtree}): ${resolved}`, {
        requested,
        reason: 'excluded',
      });
    }
  }

  return resolved;
}
